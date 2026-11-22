import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { adminPasswordRefusal, passwordRuleProblem } from '../auth/password-rules';
import { config } from '../config';
import {
  ProjectImporterService,
  type ImportResult,
} from '../content/importer.service';
import { SettingEntity, UserEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_INSTRUCTOR_EMAIL,
  DEMO_INSTRUCTOR_PASSWORD,
} from './demo-accounts';
import { NullPinService } from './null-pin.service';
import { StoryRepinService } from './story-repin.service';

/** Passed in rather than read from the environment here, so the spec can vary them. */
export interface BootstrapEnv {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
}

/** The same, for the demo accounts: asked for by name, refused where others can reach. */
export interface DemoSeedEnv {
  /** Exactly 'true' creates them. Anything else, unset included, does not. */
  SEED_DEMO_ACCOUNTS?: string;
  SEED_PASSWORD?: string;
  /**
   * Whether only this machine can reach the API; see config.bindIsLoopback.
   * Only true creates the accounts: unset is treated as reachable.
   */
  loopbackOnly?: boolean;
}

export type DemoSeedOutcome =
  | 'created'
  | 'not-requested'
  | 'refused-reachable'
  | 'refused-production'
  | 'weak-password';

export type BootstrapOutcome =
  | 'created'
  | 'already-bootstrapped'
  | 'admin-exists'
  | 'unconfigured'
  | 'invalid-email'
  | 'weak-password'
  | 'email-taken';

/**
 * Written once the first admin has been created. Its presence, not the
 * presence of an ADMIN row, is what stops a second creation: an operator who
 * deletes that account has deleted it, and the next deploy must not bring it
 * back with the password still sitting in the environment.
 */
export const ADMIN_BOOTSTRAP_KEY = 'bootstrap.admin';

/**
 * Both dialects' way of saying the table is not there: Postgres raises
 * `42P01` with "relation ... does not exist", better-sqlite3 says "no such
 * table" in the message. Narrow on purpose: it decides whether a boot failure
 * is reported as a missing migration or as itself.
 */
function missingProjectTables(error: unknown): boolean {
  const driver = error as { code?: string; message?: string } | null;
  if (!driver) return false;
  const message = driver.message ?? '';
  return (
    driver.code === '42P01' ||
    /no such table/i.test(message) ||
    /relation ".+" does not exist/i.test(message)
  );
}

/**
 * The refusal for a store the migration has not reached, in one set of words
 * for the two boot steps that can meet it first: the null-pin pass and the
 * content import (`importPlatformContent`).
 */
function missingTablesSentence(root: string, error: unknown): string {
  return (
    `the project tables are not there, so ${root} could not be imported: this instance ` +
    'needs RUN_MIGRATIONS=true, or a database another instance has already migrated, ' +
    `before it can serve content (${(error as Error).message})`
  );
}

/**
 * First-boot accounts.
 *
 * Production gets exactly one thing: an ADMIN, created from ADMIN_EMAIL and
 * ADMIN_PASSWORD, once. After that the variables are inert, and no account
 * ever appears on a domain the operator does not own.
 *
 * The demo staff accounts are a separate, explicit request: SEED_DEMO_ACCOUNTS=true.
 * NODE_ENV is the wrong question: the laptop that hosts a section sets none,
 * so gating on it would publish the demo ADMIN account to everyone on the
 * network. The right question is who can reach this process, so the seed also
 * refuses unless the bind is known to be loopback, however loudly the variable
 * asks, and refuses under NODE_ENV=production as well: a production API on
 * loopback behind a reverse proxy on the same host is still reachable.
 * scripts/start.sh sets it for the local demo; the API and browser suites set
 * it in their harnesses.
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);
  private imported: ImportResult[] | null = null;

  constructor(
    private readonly auth: AuthService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(SettingEntity) private readonly settings: Repository<SettingEntity>,
    private readonly importer: ProjectImporterService,
    private readonly storyRepin: StoryRepinService,
    private readonly nullPin: NullPinService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // First in the seed's bootstrap: a null pin read the stored head until this boot, so it is pinned to that
    // version before this boot's import can publish another. A pass that cannot finish stops the boot.
    await this.nullPin.run().catch((error: unknown) => {
      if (!missingProjectTables(error)) throw error;
      throw new Error(missingTablesSentence(config.contentDir, error));
    });
    // Content next. A deployment whose packs cannot be imported has nothing to
    // teach, the refusal is the boot's own, and an admin account created
    // on the way to it would be the one write a failed boot left behind.
    await this.importPlatformContent();
    await this.bootstrapAdmin({
      ADMIN_EMAIL: config.adminEmail,
      ADMIN_PASSWORD: config.adminPassword,
    });
    await this.seedDemoAccounts({
      SEED_DEMO_ACCOUNTS: config.seedDemoAccounts ? 'true' : undefined,
      SEED_PASSWORD: config.seedPassword,
      loopbackOnly: config.bindIsLoopback,
    });
    // Last: the TaskTrackr head it moves learners onto is the one the import
    // above just published, and the admin account it names as the actor of
    // every move exists by now (`StoryRepinService`).
    await this.storyRepin.run();
  }

  /**
   * The packs on disk, imported as rows.
   *
   * Content reaches production
   * by being baked into the image, so the import runs at **every** boot and is
   * idempotent on `(slug, version)` and the import's content digest rather than
   * on whether a project has ever been seeded. A bumped `project.json` imports
   * as a new published head; the same version from different bytes refuses the
   * boot by name, because a published version is immutable and the only honest
   * fix is a version bump.
   *
   * The directory is the import source and stays where it is: `config.ts`
   * derives the repository root by probing for `content/tasktrackr/project.json`,
   * which is exactly what that probe needs it for.
   *
   * Returns what it did, so the spec asserts on behaviour rather than log
   * lines, and records it, because `ProjectRegistryService` installs what
   * this published and has to be able to tell "the import found nothing" from
   * "the import has not run". An import that refuses leaves it null and the
   * boot stops here, which is the order that matters: no compiled snapshot is
   * installed off the back of a half-finished import.
   */
  async importPlatformContent(root: string = config.contentDir): Promise<ImportResult[]> {
    const results = await this.importContent(root).catch((error: unknown) => {
      // A refusal has to be a sentence, and the one shape that had none is the
      // replica started with RUN_MIGRATIONS=false (`database.module.ts`)
      // against a database the migration has not reached: the import's first
      // statement is `projects.findOneBy`, and without this the driver's own
      // "no such table" is all that comes back. Content is served from the
      // database, so such an instance must refuse with a sentence. The
      // importer's own named refusals pass through untouched.
      if (!missingProjectTables(error)) throw error;
      throw new Error(missingTablesSentence(root, error));
    });
    this.imported = results;
    return results;
  }

  private importContent(root: string): Promise<ImportResult[]> {
    return this.importer.importContentDirectory(root, {
      origin: 'seed',
      platformOwned: true,
      ownerUserId: null,
      // Nobody published the platform's own pack here, so no person is named.
      publishedByUserId: null,
      // `namedProject`, not `defaultProject`: the flag the importer sets is
      // the resolution order's fourth step, and handing it the choice-or-guess
      // would make both arms of `ensureDefaultProject` answer "whichever
      // directory sorted first" whenever DEFAULT_PROJECT is unset, which is
      // the guess that step exists to replace. An operator's choice moves the flag; nobody's choice
      // leaves it where the first-ever import put it.
      defaultSlug: config.namedProject || undefined,
      // A pack whose slug a teacher's project holds is skipped and named in
      // one boot line; a refusal here would abort every pack and the boot.
      heldSlug: 'skip',
    });
  }

  /**
   * What the last import published, or null when no import has finished.
   *
   * `ProjectRegistryService` reads it: null is an ordering fault and is
   * refused by name, and an empty array is a deployment with no packs, which
   * the registry refuses for its own reason.
   */
  get importedContent(): ImportResult[] | null {
    return this.imported;
  }

  /** Returns the branch taken so the spec asserts on behaviour, not log lines. */
  async bootstrapAdmin(env: BootstrapEnv): Promise<BootstrapOutcome> {
    const email = env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = env.ADMIN_PASSWORD;
    const configured = Boolean(email && password);

    const marker = await this.settings.findOne({ where: { key: ADMIN_BOOTSTRAP_KEY } });
    if (marker) {
      if (!(await this.users.exists({ where: { role: 'ADMIN' } }))) {
        // Deliberately not fixed here: see ADMIN_BOOTSTRAP_KEY. The operator
        // has to say so explicitly by removing the marker.
        this.logger.warn(
          `the first admin was created at ${marker.value} and no ADMIN account remains; ` +
            `delete the '${ADMIN_BOOTSTRAP_KEY}' settings row to bootstrap again`,
        );
      }
      return 'already-bootstrapped';
    }

    if (await this.users.exists({ where: { role: 'ADMIN' } })) {
      if (configured) {
        this.logger.log('an ADMIN account already exists; ADMIN_EMAIL / ADMIN_PASSWORD ignored');
      }
      return 'admin-exists';
    }

    if (!email || !password) {
      // Loud in production, because a deployment with no admin has no way to
      // suspend an account or recover a password, and nothing else will say
      // so. Quiet elsewhere: the development seed is about to create one.
      const message =
        'no ADMIN account exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set; ' +
        'set both to create the first admin on the next boot';
      if (config.isProduction) this.logger.warn(message);
      else this.logger.log(message);
      return 'unconfigured';
    }

    if (!isEmail(email)) {
      // The same rule LoginDto applies: an address the sign-in form would
      // reject (a@b.c, say) would create an admin nobody can ever sign in as.
      this.logger.warn(
        'ADMIN_EMAIL is not a valid email address, so no admin was created; set one the sign-in form accepts',
      );
      return 'invalid-email';
    }

    const weak = passwordRuleProblem(password);
    if (weak) {
      // Not marked as done, like the address above: a better password and a
      // restart create the admin.
      this.logger.warn(adminPasswordRefusal(weak));
      return 'weak-password';
    }

    if (await this.users.exists({ where: { email } })) {
      // Promoting an existing account from an environment variable would be a
      // silent role change with a password the row's owner never chose.
      this.logger.warn(
        'ADMIN_EMAIL names an existing non-admin account; choose an unused address for the first admin',
      );
      return 'email-taken';
    }

    await this.auth.ensureAccount(email, password, 'Administrator', 'ADMIN');
    await this.settings.save(
      this.settings.create({ key: ADMIN_BOOTSTRAP_KEY, value: new Date().toISOString() }),
    );
    this.logger.log('first ADMIN account created from ADMIN_EMAIL; the variables are now inert');
    return 'created';
  }

  /**
   * The demo staff accounts, whose passwords are printed in the README. Returns
   * the branch taken so the spec asserts on behaviour rather than log lines.
   */
  async seedDemoAccounts(env: DemoSeedEnv): Promise<DemoSeedOutcome> {
    if (env.SEED_DEMO_ACCOUNTS !== 'true') return 'not-requested';

    if (config.isProduction) {
      this.logger.warn(
        'SEED_DEMO_ACCOUNTS=true was ignored: NODE_ENV=production, and the demo accounts ship ' +
          'passwords printed in the README. Create staff accounts from ADMIN_EMAIL / the console.',
      );
      return 'refused-production';
    }

    if (env.loopbackOnly !== true) {
      // An ADMIN account with a published password, on an address other
      // people can open a socket to, is the whole of the incident.
      this.logger.warn(
        'SEED_DEMO_ACCOUNTS=true was ignored: this API is bound to an address other machines can ' +
          'reach, and the demo accounts ship passwords printed in the README. Bind loopback ' +
          '(unset API_BIND) for the demo, or create staff accounts from ADMIN_EMAIL / the console.',
      );
      return 'refused-reachable';
    }

    // The published defaults are the demo's own and are not held to the rules;
    // a password someone chose is.
    const weak = env.SEED_PASSWORD ? passwordRuleProblem(env.SEED_PASSWORD) : null;
    if (weak) {
      this.logger.warn(
        `SEED_PASSWORD was refused, so the demo accounts were not created: ${weak}. ` +
          'Choose another, or unset it to use the published demo passwords.',
      );
      return 'weak-password';
    }

    const instructorPassword = env.SEED_PASSWORD || DEMO_INSTRUCTOR_PASSWORD;
    const adminPassword = env.SEED_PASSWORD || DEMO_ADMIN_PASSWORD;
    await this.auth.ensureAccount(
      DEMO_INSTRUCTOR_EMAIL,
      instructorPassword,
      'Dana Instructor',
      'INSTRUCTOR',
    );
    await this.auth.ensureAccount(DEMO_ADMIN_EMAIL, adminPassword, 'Ade Admin', 'ADMIN');
    this.logger.log(
      `demo accounts ensured (${DEMO_INSTRUCTOR_EMAIL}, ${DEMO_ADMIN_EMAIL}) because ` +
        'SEED_DEMO_ACCOUNTS=true; their passwords are published, so this is a loopback-only setting',
    );
    return 'created';
  }
}
