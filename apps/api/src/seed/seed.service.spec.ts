import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DataSource, IsNull } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { config } from '../config';
import { ALL_ENTITIES, SettingEntity, UserEntity } from '../db/entities';
import type { ProjectImporterService } from '../content/importer.service';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { EnrollmentEntity } from '../db/entities';
import { NullPinService } from './null-pin.service';
import { ADMIN_BOOTSTRAP_KEY, SeedService } from './seed.service';
import type { StoryRepinService } from './story-repin.service';
import { memoryDataSource } from '../../test/support/memory-db';
import { DEMO_ADMIN_EMAIL, DEMO_INSTRUCTOR_EMAIL } from './demo-accounts';

const DEMO_ADDRESSES: string[] = [DEMO_ADMIN_EMAIL, DEMO_INSTRUCTOR_EMAIL];

/** The re-pin, stubbed: it has its own spec, with a database behind it. */
const noRepin = { run: async () => null } as unknown as StoryRepinService;
/** The null-pin pass, stubbed the same way (`null-pin.spec.ts`). */
const noNullPin = {
  run: async () => ({ pinnedFromNull: 0, pinnedProjects: 0, unpinnedNoHead: 0, unpinnedProjects: 0 }),
} as unknown as NullPinService;

/**
 * The importer, recorded rather than run: these two suites are about accounts,
 * and the content branch has its own spec (`seed-import.spec.ts`) with a real
 * database and a real pack behind it.
 */
const recordingImporter = (): {
  importer: ProjectImporterService;
  calls: { root: string | undefined; defaultSlug: string | undefined }[];
} => {
  const calls: { root: string | undefined; defaultSlug: string | undefined }[] = [];
  const importer = {
    importContentDirectory: async (root?: string, options?: { defaultSlug?: string }) => {
      calls.push({ root, defaultSlug: options?.defaultSlug });
      return [];
    },
  } as unknown as ProjectImporterService;
  return { importer, calls };
};

describe('SeedService.bootstrapAdmin', () => {
  let dataSource: DataSource;
  let seed: SeedService;

  const env = { ADMIN_EMAIL: 'Ops@Example.EDU', ADMIN_PASSWORD: 'Correct-Horse-9' };
  const admins = () => dataSource.manager.find(UserEntity, { where: { role: 'ADMIN' } });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    const users = dataSource.getRepository(UserEntity);
    seed = new SeedService(
      new AuthService(passwordWorkFixture(), users, new JwtService({ secret: 'seed-spec-secret' })),
      users,
      dataSource.getRepository(SettingEntity),
      recordingImporter().importer,
      noRepin,
      noNullPin,
    );
  });

  it('does nothing without both variables', async () => {
    expect(await seed.bootstrapAdmin({})).toBe('unconfigured');
    expect(await seed.bootstrapAdmin({ ADMIN_EMAIL: env.ADMIN_EMAIL })).toBe('unconfigured');
    expect(await seed.bootstrapAdmin({ ADMIN_PASSWORD: env.ADMIN_PASSWORD })).toBe('unconfigured');
    expect(await admins()).toHaveLength(0);
    expect(await dataSource.manager.count(SettingEntity)).toBe(0);
  });

  it('refuses an address the sign-in form would reject, rather than creating an admin nobody can use', async () => {
    expect(await seed.bootstrapAdmin({ ADMIN_EMAIL: 'a@b.c', ADMIN_PASSWORD: env.ADMIN_PASSWORD })).toBe(
      'invalid-email',
    );
    expect(await admins()).toHaveLength(0);
    // Not marked as done: fixing the variable and restarting must still work.
    expect(await dataSource.manager.count(SettingEntity)).toBe(0);
  });

  it('refuses an ADMIN_PASSWORD registration would refuse, and creates nothing until it is fixed', async () => {
    for (const weak of ['short1!', 'x'.repeat(101), 'password123']) {
      expect(await seed.bootstrapAdmin({ ADMIN_EMAIL: env.ADMIN_EMAIL, ADMIN_PASSWORD: weak })).toBe(
        'weak-password',
      );
    }
    expect(await admins()).toHaveLength(0);
    expect(await dataSource.manager.count(SettingEntity)).toBe(0);
    expect(await seed.bootstrapAdmin(env)).toBe('created');
  });

  it('creates the first admin from the environment, once', async () => {
    expect(await seed.bootstrapAdmin(env)).toBe('created');

    const [admin] = await admins();
    expect(admin.email).toBe('ops@example.edu');
    expect(await bcrypt.compare(env.ADMIN_PASSWORD, admin.passwordHash)).toBe(true);
    expect(await dataSource.manager.findOneBy(SettingEntity, { key: ADMIN_BOOTSTRAP_KEY })).not.toBeNull();

    expect(await seed.bootstrapAdmin(env)).toBe('already-bootstrapped');
    expect(await dataSource.manager.count(UserEntity)).toBe(1);
  });

  it('never resurrects the admin once it has been deleted', async () => {
    await seed.bootstrapAdmin(env);
    await dataSource.manager.delete(UserEntity, { role: 'ADMIN' });

    // The old seed recreated a deleted staff account on every boot, so
    // deleting it was not a way to close it. This is the assertion that it is.
    expect(await seed.bootstrapAdmin(env)).toBe('already-bootstrapped');
    expect(await admins()).toHaveLength(0);
  });

  it('leaves an admin that already exists alone', async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email: 'existing@example.edu',
        passwordHash: 'x',
        displayName: 'Existing',
        role: 'ADMIN',
      }),
    );
    expect(await seed.bootstrapAdmin(env)).toBe('admin-exists');
    expect((await admins()).map((a) => a.email)).toEqual(['existing@example.edu']);
    expect(await dataSource.manager.count(SettingEntity)).toBe(0);
  });

  it('refuses to promote an existing non-admin account', async () => {
    await dataSource.manager.save(
      dataSource.manager.create(UserEntity, {
        email: 'ops@example.edu',
        passwordHash: 'x',
        displayName: 'Learner',
      }),
    );
    expect(await seed.bootstrapAdmin(env)).toBe('email-taken');
    const row = await dataSource.manager.findOneByOrFail(UserEntity, { email: 'ops@example.edu' });
    expect(row.role).toBe('LEARNER');
    expect(row.passwordHash).toBe('x');
    expect(await admins()).toHaveLength(0);
  });
});


describe('SeedService.seedDemoAccounts', () => {
  let dataSource: DataSource;
  let seed: SeedService;

  const demoRows = () =>
    dataSource.manager
      .find(UserEntity)
      .then((rows) => rows.map((u) => u.email).filter((address) => DEMO_ADDRESSES.includes(address)));

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    const users = dataSource.getRepository(UserEntity);
    seed = new SeedService(
      new AuthService(passwordWorkFixture(), users, new JwtService({ secret: 'seed-spec-secret' })),
      users,
      dataSource.getRepository(SettingEntity),
      recordingImporter().importer,
      noRepin,
      noNullPin,
    );
  });

  it('creates nothing unless SEED_DEMO_ACCOUNTS asks by name', async () => {
    // A gate of NODE_ENV !== 'production' is not enough: scripts/start.sh
    // sets no NODE_ENV, so the documented way to host a class would publish
    // the demo ADMIN account, password in the README, to everyone who could
    // reach the laptop.
    expect(await seed.seedDemoAccounts({})).toBe('not-requested');
    expect(await seed.seedDemoAccounts({ SEED_DEMO_ACCOUNTS: 'false' })).toBe('not-requested');
    expect(await seed.seedDemoAccounts({ SEED_DEMO_ACCOUNTS: '1' })).toBe('not-requested');
    expect(await seed.seedDemoAccounts({ SEED_PASSWORD: 'anything' })).toBe('not-requested');
    expect(await demoRows()).toEqual([]);
  });

  it('refuses them on a bind other machines can reach, however loudly asked', async () => {
    expect(await seed.seedDemoAccounts({ SEED_DEMO_ACCOUNTS: 'true', loopbackOnly: false })).toBe(
      'refused-reachable',
    );
    expect(await demoRows()).toEqual([]);
  });

  it('refuses them when the caller says nothing about the bind: only a bind known to be loopback creates them', async () => {
    expect(await seed.seedDemoAccounts({ SEED_DEMO_ACCOUNTS: 'true' })).toBe('refused-reachable');
    expect(await demoRows()).toEqual([]);
  });

  it('refuses them in production even on a loopback bind, as the demo clock does', async () => {
    const production = config.isProduction;
    config.isProduction = true;
    try {
      expect(await seed.seedDemoAccounts({ SEED_DEMO_ACCOUNTS: 'true', loopbackOnly: true })).toBe(
        'refused-production',
      );
    } finally {
      config.isProduction = production;
    }
    expect(await demoRows()).toEqual([]);
  });

  it('creates them for the loopback demo, which is what start.sh and the suites run', async () => {
    expect(await seed.seedDemoAccounts({ SEED_DEMO_ACCOUNTS: 'true', loopbackOnly: true })).toBe(
      'created',
    );
    expect((await demoRows()).sort()).toEqual([
      'admin@learnsdlc.test',
      'instructor@learnsdlc.test',
    ]);
    const admin = await dataSource.manager.findOneByOrFail(UserEntity, {
      email: 'admin@learnsdlc.test',
    });
    expect(admin.role).toBe('ADMIN');
    expect(await bcrypt.compare('Admin123!', admin.passwordHash)).toBe(true);
  });

  it('refuses a SEED_PASSWORD registration would refuse, and creates neither account', async () => {
    for (const weak of ['short1!', 'password123']) {
      expect(
        await seed.seedDemoAccounts({ SEED_DEMO_ACCOUNTS: 'true', SEED_PASSWORD: weak, loopbackOnly: true }),
      ).toBe('weak-password');
    }
    expect(await demoRows()).toEqual([]);
  });

  it('honours SEED_PASSWORD when it does create them', async () => {
    await seed.seedDemoAccounts({
      SEED_DEMO_ACCOUNTS: 'true',
      SEED_PASSWORD: 'Correct-Horse-9',
      loopbackOnly: true,
    });
    const instructor = await dataSource.manager.findOneByOrFail(UserEntity, {
      email: 'instructor@learnsdlc.test',
    });
    expect(await bcrypt.compare('Correct-Horse-9', instructor.passwordHash)).toBe(true);
  });
});

describe('SeedService.onApplicationBootstrap', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('imports the packs on disk at every boot, and before it writes an account', async () => {
    const users = dataSource.getRepository(UserEntity);
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);

    // The content branch runs on every boot, because that is how a content fix
    // reaches production, and it runs first: a deployment whose packs
    // cannot be imported has nothing to teach, and an account created on the
    // way to that refusal is the one write a failed boot would leave behind.
    const seen: { root: string | undefined; defaultSlug: string | undefined; accounts: number }[] = [];
    const importer = {
      importContentDirectory: async (root?: string, options?: { defaultSlug?: string }) => {
        seen.push({ root, defaultSlug: options?.defaultSlug, accounts: await users.count() });
        return [];
      },
    } as unknown as ProjectImporterService;

    // The re-pin runs once per boot, after the import it moves learners onto
    // and after the admin account it names as the actor of every move.
    const repinAfterImports: number[] = [];
    const adminsAtRepin: number[] = [];
    const repin = {
      run: async () => (repinAfterImports.push(seen.length), adminsAtRepin.push(await users.countBy({ role: 'ADMIN' })), null),
    } as unknown as StoryRepinService;

    const seed = new SeedService(
      new AuthService(passwordWorkFixture(), users, new JwtService({ secret: 'seed-spec-secret' })),
      users,
      dataSource.getRepository(SettingEntity),
      importer,
      repin,
      noNullPin,
    );
    await seed.onApplicationBootstrap();
    expect(repinAfterImports).toEqual([1]);
    expect(adminsAtRepin).toEqual([1]);

    // `defaultSlug` is the operator's *choice* (`namedProject`) and not the
    // choice-or-guess (`defaultProject`): the flag the importer sets is the
    // resolution order's fourth step, and a fourth step seeded from directory
    // order is the guess it exists to replace. This deployment names none, so
    // the seed names none.
    expect(config.namedProject).toBe('');
    expect(seen).toEqual([{ root: config.contentDir, defaultSlug: undefined, accounts: 0 }]);
    // and the accounts branch still ran afterwards, unchanged
    expect((await users.find()).map((user) => user.email).sort()).toEqual([
      'admin@learnsdlc.test',
      'instructor@learnsdlc.test',
    ]);
  });
  /** A SeedService over this store whose four boot steps record the order they ran in. */
  const recordingBoot = (nullPin: NullPinService) => {
    const users = dataSource.getRepository(UserEntity);
    const order: string[] = [];
    const importer = {
      importContentDirectory: async () => (order.push('import'), []),
    } as unknown as ProjectImporterService;
    const repin = { run: async () => (order.push('repin'), null) } as unknown as StoryRepinService;
    const pass = { run: async () => (order.push('null-pin'), nullPin.run()) } as unknown as NullPinService;
    const seed = new SeedService(
      new AuthService(passwordWorkFixture(), users, new JwtService({ secret: 'seed-spec-secret' })),
      users,
      dataSource.getRepository(SettingEntity),
      importer,
      repin,
      pass,
    );
    const admin = seed.bootstrapAdmin.bind(seed);
    jest.spyOn(seed, 'bootstrapAdmin').mockImplementation(async (env) => (order.push('admin'), admin(env)));
    return { seed, order };
  };

  it('runs the null-pin pass before the import, the admin and the re-pin', async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    const { seed, order } = recordingBoot(new NullPinService(dataSource));
    await seed.onApplicationBootstrap();
    expect(order).toEqual(['null-pin', 'import', 'admin', 'repin']);
  });

  it('stops the boot before the import when the pass fails, in the import\'s sentence for a store with no project tables', async () => {
    const bare = await memoryDataSource();
    try {
      await bare.query('DROP TABLE "enrollments"');
      const order: string[] = [];
      const importer = {
        importContentDirectory: async () => (order.push('import'), []),
      } as unknown as ProjectImporterService;
      const users = bare.getRepository(UserEntity);
      const seed = new SeedService(
        new AuthService(passwordWorkFixture(), users, new JwtService({ secret: 'seed-spec-secret' })),
        users,
        bare.getRepository(SettingEntity),
        importer,
        { run: async () => (order.push('repin'), null) } as unknown as StoryRepinService,
        new NullPinService(bare),
      );
      const refused = await seed.onApplicationBootstrap().then(() => null, (error: Error) => error.message);
      expect(refused?.startsWith(
        `the project tables are not there, so ${config.contentDir} could not be imported: this instance ` +
          'needs RUN_MIGRATIONS=true, or a database another instance has already migrated, before it can serve content (',
      )).toBe(true);
      expect(refused).toMatch(/no such table: enrollments\)$/);
      expect(order).toEqual([]);
      expect(seed.importedContent).toBeNull();
      expect(await users.count()).toBe(0);
    } finally {
      await bare.destroy();
    }
  });

  it('stops the boot before the import when the pass throws any other error, and passes the error through', async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    const order: string[] = [];
    const importer = {
      importContentDirectory: async () => (order.push('import'), []),
    } as unknown as ProjectImporterService;
    const users = dataSource.getRepository(UserEntity);
    const seed = new SeedService(
      new AuthService(passwordWorkFixture(), users, new JwtService({ secret: 'seed-spec-secret' })),
      users,
      dataSource.getRepository(SettingEntity),
      importer,
      { run: async () => (order.push('repin'), null) } as unknown as StoryRepinService,
      { run: async () => Promise.reject(new Error('disk full')) } as unknown as NullPinService,
    );
    // never warned and gone on: an import over rows left null is the move the pass exists to prevent
    await expect(seed.onApplicationBootstrap()).rejects.toThrow(/^disk full$/);
    expect(order).toEqual([]);
    expect(seed.importedContent).toBeNull();
    expect(await users.count()).toBe(0);
  });

  it('the pass\'s pinned plus left counts equal the store\'s null rows', async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    const manager = dataSource.manager;
    const shelf = await manager.save(manager.create(ProjectEntity, { slug: 'shelf', title: 'Shelf', platformOwned: false, origin: 'upload' }));
    await manager.save(
      manager.create(ProjectVersionEntity, { projectId: shelf.id, version: '1.0.0', status: 'published', manifest: {} as never, compiled: { content: { phases: [] } } as never, publishedAt: new Date().toISOString() }),
    );
    for (const slug of ['shelf', 'shelf', 'no-such-project']) {
      await manager.save(manager.create(EnrollmentEntity, { userId: `learner-${slug}-${Math.random()}`, projectSlug: slug, projectVersionId: null }));
    }
    const nullRows = await manager.count(EnrollmentEntity, { where: { projectVersionId: IsNull() } });
    expect(nullRows).toBe(3);

    const pass = new NullPinService(dataSource);
    const ran = jest.spyOn(pass, 'run');
    const { seed } = recordingBoot(pass);
    await seed.onApplicationBootstrap();
    const result = await ran.mock.results[0].value;
    expect(result.pinnedFromNull + result.unpinnedNoHead).toBe(nullRows);
    expect(result).toEqual({ pinnedFromNull: 2, pinnedProjects: 1, unpinnedNoHead: 1, unpinnedProjects: 1 });
  });
});
