import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SettingEntity } from '../db/entities';
import { STORY_MIGRATION_RECEIPT_KEY } from '../migrations/story-records/story-records';
import { DESIGN_MIGRATION_RECEIPT_KEY } from '../migrations/design-records/design-records';
import { RUNBOOK_MIGRATION_RECEIPT_KEY } from '../migrations/runbook-records/runbook-records';
import { CHANGE_MIGRATION_RECEIPT_KEY } from '../migrations/change-records/change-records';
import { AuthoringService } from './authoring.service';

/** Written once the story pass has run; its presence is what makes it one-time. */
export const STORY_DRAFTS_DONE_KEY = 'story-model.drafts.done';
/** Written once the design pass has run, apart from the story pass's marker. */
export const DESIGN_DRAFTS_DONE_KEY = 'design-model.drafts.done';

/** Written once the runbook pass has run, apart from the other passes' markers. */
export const RUNBOOK_DRAFTS_DONE_KEY = 'runbook-model.drafts.done';
/** Written once the change pass has run, apart from the other passes' markers. */
export const CHANGE_DRAFTS_DONE_KEY = 'change-model.drafts.done';

/** Written once the plain-text pass has run, apart from the record passes' markers. */
export const PLAIN_TEXT_DRAFTS_DONE_KEY = 'plain-text.drafts.done';
/**
 * The plain-text pass's own receipt: `{ at, converted, refused, skipped, counts }`, version ids and counts,
 * never a word a teacher wrote. No migration writes it; the pass is its only writer.
 */
export const PLAIN_TEXT_RECEIPT_KEY = 'plain-text.receipt';

/** Which structured kind a pass converts drafts to; `plain-text` stores every text of a draft plain. */
export type DraftKind = 'story' | 'design' | 'runbook' | 'change' | 'plain-text';

/** What a pass's conversion answers, as the log and the receipt read it. */
interface DraftPassOutcome {
  converted: string[];
  refused: { versionId: string; reason: string }[];
  /** The plain-text pass's alone: the drafts an earlier pass refused, left as they were. */
  skipped?: { versionId: string; reason: string }[];
  notes: string[];
  /** The plain-text pass's alone: its receipt's counts. */
  counts?: Record<string, number>;
}

/** What differs between the passes: the conversion, the marker, the receipt, and the words of the log. */
interface DraftPass {
  doneKey: string;
  receiptKey: string;
  convert(authoring: AuthoringService): Promise<DraftPassOutcome>;
  /** The phase the drafts held in the older format, as the log names it; the plain-text pass reads every phase. */
  phase: 'Requirements' | 'Design' | 'Deployment' | 'Maintenance' | 'every phase';
  /** What the log calls that older form: the markdown kind, or the older format of a record phase. */
  older: 'markdown' | 'older-format';
  /** The log's prefixes: the drafts line, and the migration's workspace counts. */
  drafts: string;
  migration: string;
}

const PASSES: Record<DraftKind, DraftPass> = {
  story: {
    doneKey: STORY_DRAFTS_DONE_KEY,
    receiptKey: STORY_MIGRATION_RECEIPT_KEY,
    convert: (authoring) => authoring.convertLegacyRequirementsDrafts(),
    phase: 'Requirements',
    older: 'markdown',
    drafts: 'story drafts',
    migration: 'story migration: requirements workspaces',
  },
  design: {
    doneKey: DESIGN_DRAFTS_DONE_KEY,
    receiptKey: DESIGN_MIGRATION_RECEIPT_KEY,
    convert: (authoring) => authoring.convertLegacyDesignDrafts(),
    phase: 'Design',
    older: 'markdown',
    drafts: 'design drafts',
    migration: 'design migration: design workspaces',
  },
  runbook: {
    doneKey: RUNBOOK_DRAFTS_DONE_KEY,
    receiptKey: RUNBOOK_MIGRATION_RECEIPT_KEY,
    convert: (authoring) => authoring.convertLegacyRunbookDrafts(),
    phase: 'Deployment',
    older: 'older-format',
    drafts: 'runbook drafts',
    migration: 'runbook migration: deployment workspaces',
  },
  change: {
    doneKey: CHANGE_DRAFTS_DONE_KEY,
    receiptKey: CHANGE_MIGRATION_RECEIPT_KEY,
    convert: (authoring) => authoring.convertLegacyChangeDrafts(),
    phase: 'Maintenance',
    older: 'older-format',
    drafts: 'change drafts',
    migration: 'change migration: maintenance workspaces',
  },
  'plain-text': {
    doneKey: PLAIN_TEXT_DRAFTS_DONE_KEY,
    receiptKey: PLAIN_TEXT_RECEIPT_KEY,
    convert: async (authoring) => {
      const out = await authoring.convertMarkdownTextDrafts();
      return { ...out, converted: out.converted.map((one) => one.versionId) };
    },
    phase: 'every phase',
    older: 'markdown',
    drafts: 'plain-text drafts',
    migration: 'plain-text migration',
  },
};

/** The boot's order: the four record passes, then the plain-text pass, which skips a draft any of them refused. */
const BOOT_ORDER: readonly DraftKind[] = ['story', 'design', 'runbook', 'change', 'plain-text'];

/**
 * Converts, once per kind, every teacher draft stored before that kind whose
 * phase is still in its older form: the story pass converts Requirements
 * (`AuthoringService.convertLegacyRequirementsDrafts`), the design pass Design
 * (`AuthoringService.convertLegacyDesignDrafts`), the runbook pass Deployment
 * (`convertLegacyRunbookDrafts`) and the change pass Maintenance
 * (`convertLegacyChangeDrafts`). A pass also converts every other older phase
 * of a draft it converts, before the draft compiles, so the sibling's own pass
 * may find that draft already done. One service for all four, each pass with its
 * own done marker and its own migration's receipt, so a store that ran the
 * earlier passes before a later kind existed still runs the later pass once.
 *
 * A fifth pass, `plain-text`, runs after the four and stores every
 * text of a draft that holds markdown as `plainTextOf` of it
 * (`AuthoringService.convertMarkdownTextDrafts`). It skips a draft any of the
 * four refused, so it never writes over a draft they left for its teacher,
 * and keeps a receipt of its own, `plain-text.receipt`, of ids and
 * counts only.
 *
 * Why at boot and not in the migrations beside it
 * (`1790100000000-S1-StoryRecordsFromMarkdown.ts`,
 * `1790200000000-S2-DesignRecordsFromMarkdown.ts`): a draft's rows are what
 * it compiles from, and its stored snapshot must follow them. Recompiling
 * needs the authoring service's own load, compile and persist, which a
 * migration cannot reach; converting the rows without recompiling would leave
 * a snapshot that says markdown over rows that say the structured kind. Every
 * door that writes a draft converts now, so one pass over the drafts already
 * stored is the whole job.
 *
 * What a pass did joins its migration's receipt, under `drafts`: the converted
 * and refused version ids and each refusal's reason. It also logs the
 * migration's workspace counts from that receipt, one line per outcome, which
 * the migration cannot print itself. Refused drafts stay as they were (the
 * walker counts each, it never fails the pass); the builder's first save of
 * that phase converts one when its teacher edits it.
 *
 * It runs after the registry's bootstrap (it depends on `AuthoringService`,
 * which depends on the registry, which depends on `SeedService`), so it runs
 * after the seed's import, the admin account and the re-pin, and a published
 * version is never what a pass reads: the passes read drafts only.
 *
 * Before the passes it reads the reference anchors' plain-text twins from
 * every published version of the reference project
 * (`AuthoringService.rememberReferenceTwins`), which writes nothing: a copy
 * the plain-text pass converted from an older reference version reads
 * `reference` from the boot on in every later process, as it did in the
 * process that converted it. Its line, "reference twins: read <n> published
 * reference version(s) for their plain-text twins", is a count only.
 */
@Injectable()
export class DraftConversionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DraftConversionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly authoring: AuthoringService,
  ) {}

  /**
   * First the reference twins (`AuthoringService.rememberReferenceTwins`), then the story pass, the design pass,
   * the runbook pass, the change pass, then the plain-text pass. A pass that cannot run is said once and left for
   * the next boot, never the boot's failure.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.rememberReferenceTwins();
    for (const kind of BOOT_ORDER) {
      try {
        await this.run(kind);
      } catch (error) {
        this.logger.warn(`${PASSES[kind].drafts}: the one-time pass did not run (${(error as Error).message}); the next boot tries again`);
      }
    }
  }

  /**
   * Every published version of the reference project read for its plain-text twins and executable keys, so a
   * copy converted from an older version reads `reference` from this boot on, not from the first draft save
   * (the AI's scope for a copy of the reference does not depend on the process's lifetime). It writes no
   * row, and it says one line, by count. One that cannot read is said and left: a draft write reads them too.
   */
  private async rememberReferenceTwins(): Promise<void> {
    try {
      const versions = await this.authoring.rememberReferenceTwins();
      this.logger.log(`reference twins: read ${versions} published reference version(s) for their plain-text twins`);
    } catch (error) {
      this.logger.warn(`reference twins: not read at boot (${(error as Error).message}); the first draft save reads them`);
    }
  }

  async run(kind: DraftKind): Promise<{ converted: number; refused: number } | null> {
    const pass = PASSES[kind];
    const settings = this.dataSource.getRepository(SettingEntity);
    if (await settings.findOneBy({ key: pass.doneKey })) return null;

    const out = await pass.convert(this.authoring);
    if (kind === 'plain-text') return this.closePlainText(pass, out);
    const said = `${pass.drafts}: converted ${out.converted.length} teacher draft(s) whose ${pass.phase} was ${pass.older === 'markdown' ? 'markdown' : 'in the older format'}; refused ${out.refused.length}`;

    const held = await settings.findOneBy({ key: pass.receiptKey });
    if (!held && out.converted.length === 0 && out.refused.length === 0) {
      // A store the migration never ran on (schema sync) with no draft to
      // convert: nothing to record, and a boot that changed nothing writes nothing.
      this.logger.log(said);
      return { converted: 0, refused: 0 };
    }
    let receipt: Record<string, unknown> = {};
    try {
      receipt = held ? (JSON.parse(held.value) as Record<string, unknown>) : {};
    } catch {
      this.logger.warn(`${pass.receiptKey}: the stored receipt is not JSON; it is written again from this pass's counts`);
      receipt = {};
    }
    receipt.drafts = { at: new Date().toISOString(), converted: out.converted, refused: out.refused };
    await settings.save({ key: pass.receiptKey, value: JSON.stringify(receipt) });
    await settings.save({ key: pass.doneKey, value: new Date().toISOString() });

    // The migration's own counts, said once on the boot after it ran: the
    // migration itself cannot print them, because `db:migrate` prints one line.
    const counts = (receipt.counts ?? {}) as Record<string, number>;
    for (const [outcome, count] of Object.entries(counts)) this.logger.log(`${pass.migration} ${outcome}: ${count}`);
    for (const note of out.notes) this.logger.log(`a stored draft: ${note}`);
    for (const refusal of out.refused) this.logger.warn(`a stored draft keeps its ${pass.older} ${pass.phase}: ${refusal.reason}`);
    this.logger.log(said);
    return { converted: out.converted.length, refused: out.refused.length };
  }

  /**
   * The plain-text pass's receipt and log: its own receipt, written whole (no migration writes it),
   * then its done marker. A boot with nothing converted, refused or skipped writes neither, as the record
   * passes write nothing then. Each converted draft's notes are logged one draft to a line; a refusal's
   * reason is logged as it fell, while the receipt holds the fixed sentence the conversion gave it.
   */
  private async closePlainText(pass: DraftPass, out: DraftPassOutcome): Promise<{ converted: number; refused: number }> {
    const skipped = out.skipped ?? [];
    const said = `${pass.drafts}: converted ${out.converted.length} teacher draft(s) whose texts held markdown; refused ${out.refused.length}; skipped ${skipped.length} an earlier pass refused`;
    if (out.converted.length === 0 && out.refused.length === 0 && skipped.length === 0) {
      this.logger.log(said);
      return { converted: 0, refused: 0 };
    }
    const settings = this.dataSource.getRepository(SettingEntity);
    const receipt = { at: new Date().toISOString(), converted: out.converted, refused: out.refused, skipped, counts: out.counts ?? {} };
    await settings.save({ key: pass.receiptKey, value: JSON.stringify(receipt) });
    await settings.save({ key: pass.doneKey, value: new Date().toISOString() });
    for (const note of out.notes) this.logger.log(`a stored draft: ${note}`);
    for (const refusal of out.refused) this.logger.warn(`a stored draft keeps its markdown: ${refusal.reason}`);
    this.logger.log(said);
    return { converted: out.converted.length, refused: out.refused.length };
  }
}
