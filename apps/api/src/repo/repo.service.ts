import {
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import {
  REPO_BRANCH,
  REPO_EXPORT_MAX_BYTES,
  repoArchiveName,
  type DossierPhase,
  type PhaseKey,
  type RepoExportResult,
  type RepoSummaryView,
} from "@learnsdlc/shared";
import { hintsByPhaseState } from "../analytics/queries";
import { ContentService } from "../content/content.service";
import { drillWithIncident } from "../workflow/drill-incident";
import { statesOnBoard } from "../workflow/states-on-board";
import type { ProjectContent } from "../content/content.types";
import {
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from "../db/entities";
import { isoOrEmpty } from "../db/timestamps";
import { recordAudit } from "../audit/audit";
import { learnerReport } from "../workflow/learner-text";
import { buildDossierJournal } from "../instructor/journal";
import { journalMarkdown, readme, readmeStart, type ReadmeInput } from "./docs";
import {
  blob,
  commit as commitObject,
  indexFile,
  looseObjectPath,
  tag as tagObject,
  treesFor,
  type GitObject,
} from "./git";
import { buildHistory, type HistoryRevision } from "./history";
import {
  centralHeader,
  dosStamp,
  endOfCentralDirectory,
  localHeader,
  type ZipEntry,
} from "./zip";

/** How many submissions cross the driver at once. A term is never resident. */
const PAGE = 100;

/**
 * The learner's own project, as a git repository they can keep.
 *
 * Its own service for the reason `PortabilityService` has one:
 * it shares nothing with the workflow but a user id, and a git writer does not
 * belong in `workflow.service.ts`.
 *
 * It writes only what the learner wrote: `submissions.workspaceSnapshot`, and
 * nothing else. The pack's reference solution is deliberately not in the
 * archive: it is not the learner's work, and a repository is a thing people
 * pass around.
 */
@Injectable()
export class RepoService {
  private readonly logger = new Logger(RepoService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly content: ContentService,
  ) {}

  /** The ceiling, read through a method so a test can stand on a small one. */
  protected maxBytes(): number {
    return REPO_EXPORT_MAX_BYTES;
  }

  private async enrollmentOf(
    manager: EntityManager,
    userId: string,
    slug: string,
  ): Promise<EnrollmentEntity> {
    const enrollment = await manager.findOne(EnrollmentEntity, {
      where: { userId, projectSlug: slug },
      order: { startedAt: "ASC" },
    });
    if (!enrollment)
      throw new NotFoundException("This project has not been started.");
    return enrollment;
  }

  /**
   * The project this enrolment's content comes from.
   *
   * All three of this file's resolutions (`summary`, `export` and the
   * journal) go through here. `getProject(slug)` would give the same project,
   * because `enrollmentOf` filters on that very slug, but not the same
   * **version**. The archive a learner downloads is cut from the version that
   * graded them rather than from whatever is published by the time they press
   * the button: the README's phase count, the card's phase titles and the
   * journal's headings are all facts about their term, and a published change
   * must not rewrite them. A null pin answers the published head, so a legacy
   * row keeps the archive it has always had.
   */
  private projectFor(enrollment: EnrollmentEntity): ProjectContent {
    return this.content.getForEnrollment(enrollment);
  }

  /**
   * The counts the card shows, without assembling a byte of the archive.
   *
   * No workspace snapshot is read on this path: one query asks which revisions
   * still have their files, and it selects the id and nothing else.
   */
  async summary(userId: string, slug: string): Promise<RepoSummaryView> {
    const manager = this.dataSource.manager;
    const enrollment = await this.enrollmentOf(manager, userId, slug);
    const project = this.projectFor(enrollment);
    const states = await manager.find(PhaseStateEntity, {
      where: { enrollmentId: enrollment.id },
      order: { phaseOrder: "ASC" },
    });
    const stateIds = states.map((state) => state.id);
    const releases = await manager.find(ReleaseRecordEntity, {
      where: { enrollmentId: enrollment.id },
      order: { phaseOrder: "ASC" },
    });

    const rows = stateIds.length
      ? await manager
          .getRepository(SubmissionEntity)
          .createQueryBuilder("submission")
          .select([
            "submission.id",
            "submission.phaseStateId",
            "submission.createdAt",
            "submission.status",
            "submission.score",
            "submission.passed",
            "submission.packVersion",
            "submission.runClock",
            "submission.commitMessage",
            "submission.regradeOf",
          ])
          .where("submission.phaseStateId IN (:...ids)", { ids: stateIds })
          .orderBy("submission.createdAt", "ASC")
          .addOrderBy("submission.id", "ASC")
          .getMany()
      : [];
    const withFiles = stateIds.length
      ? await manager
          .getRepository(SubmissionEntity)
          .createQueryBuilder("submission")
          .select(["submission.id"])
          .where("submission.phaseStateId IN (:...ids)", { ids: stateIds })
          .andWhere("submission.workspaceSnapshot IS NOT NULL")
          .getMany()
      : [];
    const kept = new Set(withFiles.map((row) => row.id));
    const titleOf = new Map<PhaseKey, string>(
      project.phases.map((phase) => [phase.key, phase.title]),
    );

    const history = buildHistory({
      projectSlug: slug,
      projectTitle: project.title,
      learnerName: "A learner",
      learnerEmail: "learner@learnsdlc.local",
      startedAt: isoOrEmpty(enrollment.startedAt),
      completedAt: enrollment.completedAt,
      phases: this.historyPhases(states, titleOf),
      revisions: rows.map((row) =>
        this.historyRevision(row, kept.has(row.id) ? {} : null),
      ),
      releases: releases.map((release) => ({
        phaseStateId: release.phaseStateId,
        phaseKey: release.phaseKey,
        version: release.version,
        notes: release.notes,
        createdAt: isoOrEmpty(release.createdAt),
      })),
      docs: { readmeStart: "", readmeFinal: "", journal: "" },
    });

    const last =
      [...history.commits].reverse().find((row) => row.phaseTitle !== null) ??
      null;
    return {
      projectSlug: slug,
      projectTitle: project.title,
      branch: REPO_BRANCH,
      commits: history.commits.length,
      emptyCommits: history.commits.filter((row) => row.empty).length,
      tags: history.tags.map((row) => ({
        name: row.name,
        phaseKey: row.phaseKey,
        phaseTitle: row.phaseTitle,
        message: row.notes,
        overridden: row.overridden,
        createdAt: row.createdAt,
      })),
      lastSubject: last?.subject ?? null,
      lastPhaseTitle: last?.phaseTitle ?? null,
      lastAt: last?.at ?? null,
      filename: repoArchiveName(slug),
    };
  }

  /**
   * The archive itself, in two passes.
   *
   * The first builds every object and weighs them; the second writes the zip
   * through `write`. Refusing has to happen before the first byte, because an
   * exception filter cannot set a status on a response that has already begun,
   * and a learner must never be handed a truncated repository.
   */
  async export(
    userId: string,
    slug: string,
    write: (chunk: Buffer) => Promise<void>,
    /** Called once the counts are known and before the first byte, for headers. */
    begin?: (info: { commits: number; tags: number }) => void,
  ): Promise<RepoExportResult> {
    const manager = this.dataSource.manager;
    const enrollment = await this.enrollmentOf(manager, userId, slug);
    const project = this.projectFor(enrollment);
    const user = await manager.findOne(UserEntity, { where: { id: userId } });
    const states = await manager.find(PhaseStateEntity, {
      where: { enrollmentId: enrollment.id },
      order: { phaseOrder: "ASC" },
    });
    const stateIds = states.map((state) => state.id);
    const releases = await manager.find(ReleaseRecordEntity, {
      where: { enrollmentId: enrollment.id },
      order: { phaseOrder: "ASC" },
    });

    // Pages of a hundred, in the order the index was built for, so a learner
    // with a term of attempts never has the whole term resident.
    const revisions: HistoryRevision[] = [];
    if (stateIds.length) {
      for (let skip = 0; ; skip += PAGE) {
        const page = await manager.find(SubmissionEntity, {
          where: { phaseStateId: In(stateIds) },
          order: { createdAt: "ASC", id: "ASC" },
          take: PAGE,
          skip,
        });
        for (const row of page)
          revisions.push(this.historyRevision(row, row.workspaceSnapshot));
        if (page.length < PAGE) break;
      }
    }

    const titleOf = new Map<PhaseKey, string>(
      project.phases.map((phase) => [phase.key, phase.title]),
    );
    const journal = await this.journalFor(
      manager,
      enrollment,
      states,
      revisions,
      releases,
    );

    // Counted over the pinned version's phases (`statesOnBoard`), as the
    // README's phase count is: a state for a phase it lacks is no pass.
    const passed = statesOnBoard(enrollment, project, states).filter(
      (state) => state.status === "passed" || state.passedAt,
    ).length;
    const readmeInput: ReadmeInput = {
      projectTitle: project.title,
      learnerName: user?.displayName || "A learner",
      exportedAt: new Date().toISOString(),
      phaseCount: project.phases.length,
      phasesPassed: passed,
      submissions: revisions.length,
      emptyCommits: revisions.filter((row) => row.snapshot == null).length,
      directories: [],
      tags: [],
    };

    // Built once with no counts, then again with them: the first commit's
    // README cannot know what the term will hold, and the last one does.
    const first = buildHistory({
      projectSlug: slug,
      projectTitle: project.title,
      learnerName: readmeInput.learnerName,
      learnerEmail: user?.email || "learner@learnsdlc.local",
      startedAt: isoOrEmpty(enrollment.startedAt),
      completedAt: enrollment.completedAt,
      phases: this.historyPhases(states, titleOf),
      revisions,
      releases: releases.map((release) => ({
        phaseStateId: release.phaseStateId,
        phaseKey: release.phaseKey,
        version: release.version,
        notes: release.notes,
        createdAt: isoOrEmpty(release.createdAt),
      })),
      docs: { readmeStart: "", readmeFinal: "", journal: "" },
    });
    const paths = new Set<string>();
    for (const row of first.commits)
      for (const path of Object.keys(row.files)) paths.add(path);
    readmeInput.directories = [
      ...new Set(
        [...paths]
          .filter((path) => path.includes("/") && !path.startsWith("docs/"))
          .map((path) => path.slice(0, path.indexOf("/"))),
      ),
    ];
    readmeInput.tags = first.tags;

    const history = buildHistory({
      projectSlug: slug,
      projectTitle: project.title,
      learnerName: readmeInput.learnerName,
      learnerEmail: user?.email || "learner@learnsdlc.local",
      startedAt: isoOrEmpty(enrollment.startedAt),
      completedAt: enrollment.completedAt,
      phases: this.historyPhases(states, titleOf),
      revisions,
      releases: releases.map((release) => ({
        phaseStateId: release.phaseStateId,
        phaseKey: release.phaseKey,
        version: release.version,
        notes: release.notes,
        createdAt: isoOrEmpty(release.createdAt),
      })),
      docs: {
        readmeStart: readmeStart(readmeInput),
        readmeFinal: readme(readmeInput),
        journal: journalMarkdown(project.title, journal, titleOf),
      },
    });

    const built = this.writeObjects(history, {
      name: readmeInput.learnerName,
      email: user?.email || "learner@learnsdlc.local",
    });

    begin?.({ commits: built.commits, tags: built.tags.length });
    const result = await this.writeArchive(built, write);
    await recordAudit(manager, {
      event: "repo.export",
      actorUserId: userId,
      subjectUserId: userId,
      targetId: enrollment.id,
      action: slug,
      detail: {
        commits: result.commits,
        tags: result.tags,
        bytes: result.bytes,
      },
    });
    this.logger.log(
      `repo export slug=${slug} commits=${result.commits} objects=${result.objects} bytes=${result.bytes}`,
    );
    return result;
  }

  /** The phases as the history names them, titled from the pack. */
  private historyPhases(
    states: PhaseStateEntity[],
    titleOf: Map<PhaseKey, string>,
  ) {
    return states.map((state) => ({
      phaseStateId: state.id,
      phaseKey: state.phaseKey,
      phaseOrder: state.phaseOrder,
      title: titleOf.get(state.phaseKey) ?? state.phaseKey,
    }));
  }

  private historyRevision(
    row: SubmissionEntity,
    snapshot: Record<string, string> | null,
  ): HistoryRevision {
    return {
      id: row.id,
      phaseStateId: row.phaseStateId,
      createdAt: isoOrEmpty(row.createdAt),
      status: row.status,
      score: row.score,
      passed: row.passed,
      assessmentMode: row.report?.assessmentMode ?? null,
      // A quiz result's texts as a learner reads them, converted here, once, whenever it was stored.
      report: learnerReport(row.report ?? null),
      packVersion: row.packVersion,
      runClock: row.runClock,
      commitMessage: row.commitMessage,
      regradeOf: row.regradeOf,
      snapshot,
    };
  }

  /** The dossier's own rows, through the builder both readers share. */
  private async journalFor(
    manager: EntityManager,
    enrollment: EnrollmentEntity,
    states: PhaseStateEntity[],
    revisions: HistoryRevision[],
    releases: ReleaseRecordEntity[],
  ) {
    const project = this.projectFor(enrollment);
    const hints = await hintsByPhaseState(
      manager,
      states.map((state) => state.id),
    );
    const attempts = new Map<string, number>();
    const phases: DossierPhase[] = states.map((state) => {
      const rows = revisions.filter((row) => row.phaseStateId === state.id);
      const phase = project.phases.find((p) => p.key === state.phaseKey);
      return {
        phaseStateId: state.id,
        key: state.phaseKey,
        order: state.phaseOrder,
        title: phase?.title ?? state.phaseKey,
        status: state.status,
        bestScore: state.bestScore,
        attempts: state.attempts,
        hints: hints.get(state.id) ?? 0,
        passedAt: state.passedAt,
        files: [],
        revisions: rows.map((row, i) => {
          attempts.set(state.id, i + 1);
          return {
            id: row.id,
            status: row.status as never,
            score: row.score,
            passed: row.passed,
            report: row.report ?? null,
            createdAt: row.createdAt,
            attempt: i + 1,
            commitMessage: row.commitMessage,
            runClock: row.runClock,
          };
        }),
        merged: null,
        mergeMessage:
          releases.find((r) => r.phaseStateId === state.id)?.notes ?? null,
        drill: phase ? drillWithIncident(state.drill, state.workspace, phase) : state.drill,
        links: state.links ?? [],
      };
    });
    return buildDossierJournal(manager, states, phases, releases);
  }

  /**
   * Every commit as git objects, oldest first, with the tree accumulated the
   * way the product accumulates a workspace: a file written in Requirements is
   * still there in Deployment.
   *
   * Content addressing is what keeps this small: sixty revisions of the same
   * ten files are sixty trees and about a dozen distinct blobs.
   */
  private writeObjects(
    history: ReturnType<typeof buildHistory>,
    who: { name: string; email: string },
  ) {
    const objects = new Map<string, GitObject>();
    const keep = (object: GitObject): string => {
      if (!objects.has(object.id)) objects.set(object.id, object);
      return object.id;
    };
    const files = new Map<string, string>();
    const blobs = new Map<string, string>();
    const shaOf = new Map<string, string>();
    let parent: string | null = null;
    let bytes = 0;
    const ceiling = this.maxBytes();

    for (const row of history.commits) {
      for (const [path, content] of Object.entries(row.files)) {
        files.set(path, content);
        const object = blob(Buffer.from(content, "utf8"));
        blobs.set(path, keep(object));
      }
      const tree = treesFor(new Map(blobs));
      for (const object of tree.objects) keep(object);
      const when = Math.floor(new Date(row.at).getTime() / 1000) || 0;
      const object = commitObject({
        tree: tree.root,
        parents: parent ? [parent] : [],
        author: { name: who.name, email: who.email, when },
        message: row.message,
      });
      keep(object);
      shaOf.set(row.key, object.id);
      parent = object.id;
      bytes = [...objects.values()].reduce((n, o) => n + o.deflated.length, 0);
      if (bytes > ceiling) {
        throw new PayloadTooLargeException(
          "Your repository is larger than a download can carry. Ask your instructor for help.",
        );
      }
    }

    const tags = history.tags.map((row) => {
      const when = Math.floor(new Date(row.createdAt).getTime() / 1000) || 0;
      const object = tagObject({
        object: shaOf.get(row.commitKey) ?? (parent as string),
        name: row.name,
        tagger: { name: who.name, email: who.email, when },
        message: row.message,
      });
      keep(object);
      return { name: row.name, id: object.id };
    });

    const newest = history.commits.reduce(
      (at, row) => Math.max(at, new Date(row.at).getTime() || 0),
      0,
    );
    return {
      objects,
      tags,
      head: parent as string,
      files,
      blobs,
      commits: history.commits.length,
      newest: new Date(newest || Date.now()),
    };
  }

  /**
   * The zip, entry by entry, into the response.
   *
   * Every stamp is taken from the newest commit rather than from the clock, so
   * two exports of an unchanged database are byte-identical and a diff of two
   * exports means something.
   */
  private async writeArchive(
    built: ReturnType<RepoService["writeObjects"]>,
    write: (chunk: Buffer) => Promise<void>,
  ): Promise<RepoExportResult> {
    const stamp = dosStamp(built.newest);
    const entries: ZipEntry[] = [];
    let at = 0;
    const put = async (path: string, body: Buffer): Promise<void> => {
      const { header, entry } = localHeader(path, body, stamp);
      entries.push({ ...entry, offset: at });
      at += header.length + body.length;
      await write(header);
      await write(body);
    };

    // The working tree first, so the folder is readable in a file manager
    // without anyone touching git.
    for (const path of [...built.files.keys()].sort()) {
      await put(path, Buffer.from(built.files.get(path) ?? "", "utf8"));
    }
    await put(
      ".git/HEAD",
      Buffer.from(`ref: refs/heads/${REPO_BRANCH}\n`, "utf8"),
    );
    await put(
      ".git/config",
      Buffer.from(
        "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n",
        "utf8",
      ),
    );
    await put(".git/refs/heads/main", Buffer.from(`${built.head}\n`, "utf8"));
    for (const tag of built.tags) {
      await put(
        `.git/refs/tags/${tag.name}`,
        Buffer.from(`${tag.id}\n`, "utf8"),
      );
    }
    await put(
      ".git/index",
      indexFile(
        [...built.blobs].map(([path, id]) => ({
          path,
          id,
          size: Buffer.byteLength(built.files.get(path) ?? "", "utf8"),
        })),
      ),
    );
    for (const [id, object] of built.objects) {
      await put(looseObjectPath(id), object.deflated);
    }

    const dirOffset = at;
    let dirSize = 0;
    for (const entry of entries) {
      const header = centralHeader(entry, stamp);
      dirSize += header.length;
      await write(header);
    }
    await write(endOfCentralDirectory(entries.length, dirSize, dirOffset));

    return {
      commits: built.commits,
      tags: built.tags.length,
      objects: built.objects.size,
      bytes: dirOffset + dirSize + 22,
    };
  }
}

