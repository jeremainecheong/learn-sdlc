import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { SeedService } from '../seed/seed.service';
import { ContentService, type RegisteredVersion } from './content.service';
import { ProjectEntity, ProjectVersionEntity } from './project.entities';

/**
 * The published versions, out of the database and into memory.
 *
 * The runtime does not walk a content directory at boot: the filesystem walk
 * lives only inside the importer and the CLIs. What the runtime reads is
 * `project_versions.compiled`: one immutable snapshot per published version,
 * holding exactly the `ProjectContent` the directory loader builds from the
 * same pack, which is the equality `import-identity.spec.ts` exists to settle.
 *
 * **Every published version, not just each project's head.** A learner pinned
 * to a superseded version has to keep resolving it: that is the whole reason
 * the pin works, and it is why the map is keyed on `project_versions.id`
 * rather than on a slug. A project's head is then derived, by comparing
 * versions field by field as numbers, and is what a request naming a project
 * answers.
 *
 * **When it runs, and why that is a constructor argument.** The seed imports
 * `content/tasktrackr` at `onApplicationBootstrap`, and this has to install
 * what that import published, so it runs after it. Being listed after
 * `SeedService` in `app.module.ts` does not arrange that: Nest calls bootstrap
 * hooks in ascending order of *dependency depth*, not in the order providers
 * are declared, so a provider that depends on little runs first and this
 * registry, which needs only `ContentService` and the `DataSource`, would
 * have read an empty table on a first boot and installed nothing. Depending on
 * `SeedService` is what puts this hook strictly after the seed's, and it is
 * also what lets the refusal below be specific: the registry can say that the
 * import has not run rather than that the table is empty.
 *
 * It holds no state of its own. The map is `ContentService`'s, because that is
 * what every reader already has injected and because the accessors that
 * resolve a pin are the same accessors that resolve a slug.
 */
@Injectable()
export class ProjectRegistryService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ProjectRegistryService.name);

  constructor(
    private readonly content: ContentService,
    private readonly dataSource: DataSource,
    private readonly seed: SeedService,
  ) {}

  /**
   * The early install, and it is best effort by design.
   *
   * Nest runs **every** module-init hook before **any** bootstrap hook, and
   * this is the only point at which content can be in place for a service
   * whose own boot work reads it. There is one: `NotificationsService` sweeps
   * at bootstrap and asks the pack for a phase's title, and it does so at a
   * shallower dependency depth than this registry can ever have: it cannot
   * wait for the seed's import, and this registry must. Without this hook a
   * restart's first sweep would write the phase *key* into a learner's
   * notification instead of its title, a learner-visible difference.
   *
   * A restart has the published rows already, so this installs them. A first
   * boot has an empty table, nothing to install and nobody to serve, and the
   * seed's import at bootstrap is what fills it. Anything that goes wrong here
   * (a database that is not up, a table a migration has not created yet) is
   * left to the bootstrap read, which is the one that decides and the one that
   * refuses.
   */
  async onModuleInit(): Promise<void> {
    try {
      const versions = await this.publishedVersions();
      if (versions.length === 0) return;
      this.content.installVersions(versions);
      this.logger.log(
        `installed ${versions.length} published project version(s) before the boot's other work`,
      );
    } catch (error) {
      this.logger.warn(
        'the published versions could not be read before the rest of the boot ' +
          `(${(error as Error).message}); the import at bootstrap decides`,
      );
    }
  }

  /**
   * The boot's install, and the two refusals that keep a broken deployment
   * from looking like a working one.
   *
   * An instance that registers nothing answers `unknown project` to every
   * learner, every instructor and every health check that only asks whether
   * the process is up: a 404 per request instead of one refusal an operator
   * can read. Boot safety is the rule: a failure says which sentence it is,
   * and it says it once.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.seed.importedContent === null) {
      throw new Error(
        'the project registry ran before the content import. It depends on SeedService so that ' +
          'every pack under CONTENT_DIR is imported before a compiled snapshot is installed, and ' +
          'that ordering did not hold — nothing is registered, so this instance would answer ' +
          'every request "unknown project".',
      );
    }
    const installed = await this.load();
    if (installed === 0) {
      throw new Error(
        'no published project version holds a compiled snapshot, so this instance would answer ' +
          `every request "unknown project". The boot imports every pack under ${config.contentDir} ` +
          '(CONTENT_DIR) and publishes it; src/cli/import-pack.ts imports one from a terminal. ' +
          'Refusing to start rather than serving an empty catalogue.',
      );
    }
    this.logger.log(`registered ${installed} published project version(s) from the database`);
  }

  /**
   * Read every published version and install it. Returns how many were
   * installed, so a boot log and a spec say the same thing.
   *
   * Finding none is not a reason to empty a registry that is answering
   * learners right now: this is also the reload an authoring publish calls,
   * and the honest response to "the read came back empty" is to
   * say so and leave the previous answer standing. The boot's own reading of
   * zero is the refusal above.
   */
  async load(): Promise<number> {
    const versions = await this.publishedVersions();
    if (versions.length === 0) {
      this.logger.warn(
        'no published project version holds a compiled snapshot; nothing was registered',
      );
      return 0;
    }
    this.content.installVersions(versions);
    return versions.length;
  }

  /**
   * Every published version that holds a compiled snapshot, in version order
   * per project.
   *
   * A published row whose `compiled` is null is skipped **by name** rather than
   * silently: the import publishes as it compiles, so the combination means a
   * row written by a surface that did not finish, and a learner pinned to it
   * would resolve nothing. Skipping it leaves the pin to fall back to the head,
   * which is the answer the platform gave before the pin existed.
   */
  async publishedVersions(): Promise<RegisteredVersion[]> {
    const projects = await this.dataSource.getRepository(ProjectEntity).find();
    const slugById = new Map(projects.map((project) => [project.id, project.slug]));
    const rows = await this.dataSource
      .getRepository(ProjectVersionEntity)
      .find({ where: { status: 'published' } });

    const out: RegisteredVersion[] = [];
    for (const row of rows) {
      const slug = slugById.get(row.projectId);
      if (!slug) {
        this.logger.warn(
          `project version ${row.id} at ${row.version} names the project ${row.projectId}, which has no row; skipped`,
        );
        continue;
      }
      if (!row.compiled) {
        this.logger.warn(
          `"${slug}" ${row.version} is published with no compiled snapshot; skipped, so an enrolment pinned to it resolves the head`,
        );
        continue;
      }
      out.push({
        versionId: row.id,
        content: row.compiled.content,
        // `?? ''` rather than a default identity: a snapshot written before the
        // compiler recorded itself is a snapshot this build did not produce,
        // and saying so is the whole point of carrying it.
        compiler: row.compiled.compiler ?? '',
        // The task list each phase was **published** with. Without it the
        // runtime would have no way to know that a phase held more than the
        // one task it synthesises, which is every question the task grain
        // asks. `?? undefined` rather than `?? []`: a row written
        // before the compiler recorded tasks stored none, and an empty list
        // would say the version's phases have no tasks rather than that this
        // deployment stored none for it.
        phases: row.compiled.phases ?? undefined,
      });
    }
    return out;
  }
}
