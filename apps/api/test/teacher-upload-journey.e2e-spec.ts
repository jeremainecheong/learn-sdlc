import * as fs from 'fs';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { API_CONTRACT_JSON, BUDGET_CEILING, CHANGE_REQUEST_JSON, DESIGN_JSON, EMPTY_DESIGN, EMPTY_RUNBOOK, EMPTY_STORY, INHERITED_TASK_KEY, RUNBOOK_JSON, SIGNOFF_ROUTES, SOLUTION_LOCKED_MESSAGE, retiredWrittenPhaseUploadRefusal, serialiseChangeRequest, serialiseDesign, serialiseRunbook, serialiseStory } from '@learnsdlc/shared';
import type { BulkSignoffResult, RunResult, SignoffQueueView, TestCaseResult } from '@learnsdlc/shared';
import {
  OpenAiProvider,
  composeChatMessages,
  composeGuidedRepairMessages,
  composeGuidedReviewMessages,
  composeInterviewMessages,
  composeReviewMessages,
  reviewResponseSchema,
} from '../src/assistant/openai.provider';
import { taskScopeOf } from '../src/assistant/project-scope';
import { AuthService } from '../src/auth/auth.service';
import { DEEP_VALIDATION_SCOPE, DeepValidationService, hasCurrentDeepReceipt } from '../src/authoring/deep-validation';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import { deepReceiptRefusal } from '../src/authoring/validation';
import { SEALED_REFUSALS } from '../src/authoring/sealed-roles';
import { canonicalJson } from '../src/content/blob.store';
import { ContentService } from '../src/content/content.service';
import { sandboxBudgetFor, type CompiledSnapshot } from '../src/content/pack-compiler';
import type { CodeChecks, ConfigChecks, TestsChecks } from '../src/content/content.types';
import { ProjectFileEntity, ProjectPhaseEntity, ProjectVersionEntity } from '../src/content/project.entities';
import { readZip, zipLimits } from '../src/content/zip-reader';
import { config } from '../src/config';
import { AuditEventEntity, EnrollmentEntity, PhaseStateEntity, UserEntity } from '../src/db/entities';
import { SandboxService } from '../src/execution/sandbox.service';
import type { SandboxJob } from '../src/execution/sandbox.service';
import { mockAiForRoutes } from './mock-ai';
import { entriesOf, writeZip } from './fixtures/upload-packs/archive';
import { SHELF_DIR, SHELF_MARKERS } from './fixtures/upload-packs/markers';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The teacher's whole road and the learner's whole road over one uploaded
 * project, on the real `AppModule` and its real routes.
 *
 * 1. A teacher uploads the Shelf pack (`upload-packs/shelf`) and gets a draft whose
 *    fast validation is clean, with its `project.uploaded` audit row.
 * 2. The teacher edits Implementation's hidden suite through the sealed door.
 * 3. Deep validation refuses first (the edited suite asserts nothing, so the
 *    starter already passes it) by its own sentence; the teacher writes a
 *    suite with teeth and deep validation passes, its receipt stored.
 * 4. The version publishes within the ceiling and a class is put on it.
 * 5. A learner fails and then passes every phase in order: Requirements and
 *    Design through the capturing AI stub, Implementation graded against the
 *    teacher's edited suite, Testing's kill matrix, Deployment's smoke
 *    and drill, Maintenance.
 * 6. Bulk sign-off of Requirements' task, which the teacher marked
 *    through the editor route on the draft (step 4): an empty reason is
 *    refused, one reason writes one audited row per learner and opens each
 *    phase once.
 * 7. Export → re-upload: the same compiled task list; a copy of the
 *    platform project withholds its inherited sealed files.
 *
 * **The sealed grep** runs after every fail and every pass of the learner: no
 * learner-facing response body (phase detail and files, run and submit
 * results, feedback, evidence, mentor, explain, the account export) and no AI
 * request the stub received holds a Shelf sealed marker, the teacher's own
 * sealed edit, or a TaskTrackr name, path or fact; and a line the pack serves the
 * learner IS in what was captured (the grep reads real bytes, or it reads
 * nothing).
 *
 * **The stub sandbox** (the pattern of authoring-executable.e2e-spec.ts and
 * deep-validation.e2e-spec.ts, copied, never imported): only the transport is
 * replaced, so every job still goes through the RunGate under the learner
 * limits. A runner without kernel isolation refuses learner code, and no
 * runner env is set to change that. A job is
 * judged by its bytes: a code job passes when every editable file it carries
 * is a known-good answer (the pack's reference solution, or the learner's
 * finished files written below), or when it carries a suite that asserts
 * nothing; a tests job passes on the reference implementation and fails on a
 * mutant; a smoke job fails on the drill's faulted copy.
 *
 * **The capturing AI stub** is `OpenAiProvider` overridden by a wrapper of the
 * routes' mock (`mock-ai.ts`'s verdict rule: pass when every check passed).
 * What it receives are the services' typed arguments, not a composed request,
 * so it greps two things. (1) Every argument, captured whole except the
 * compiled `checks` store of a phase or task (an object carrying `kind`),
 * which holds the sealed bytes by design. (2) The request the provider would
 * have sent: the stub hands the same arguments to the provider's own exported
 * composers, the ones `OpenAiProvider.chat/review/interview` call
 * (`composeChatMessages`, `composeGuidedReviewMessages`,
 * `composeGuidedRepairMessages`, `composeReviewMessages` with
 * `reviewResponseSchema`, `composeInterviewMessages`), and greps the composed
 * messages unscrubbed: provider constants and whatever a composer pulls out
 * of `checks` included. Each composed review must carry a line of
 * the workspace it was handed (the grep reads real bytes). Real AI calls: none.
 *
 * **No allowance is left.** An `own` phase carries `referenceName: null`, so
 * every TaskTrackr byte anywhere is a leak. The solution door is an accepted
 * product rule, asserted here: the door (`solution.service.ts`) is shut (403,
 * its own sentence) before the
 * learner's own reviewed pass and open (200) after it, where a `code` phase's
 * door answers the teacher's solution (its marker, and only that one) and a
 * `tests` phase's door the reference suite (likewise); hidden tests, impl,
 * mutants, drills, the teacher's EDIT/WEAK markers and every TaskTrackr word
 * stay forbidden on every door. `JOURNEY_STRICT` (inline): `1` takes out every
 * allowance that is not accepted: there is none, so `1` is green;
 * `SOL-DOOR` is an informational probe that greps the open door for the
 * accepted markers too, so it is RED BY DESIGN.
 *
 * **Sign-off is marked through the product.** The teacher
 * marks Requirements' sole task with `PATCH …/tasks/main {signOff:true}` on
 * the draft, before publish (step 4); the learner's Requirements pass then
 * waits for the countersignature, the teacher signs it off in bulk right after
 * that pass, and step 6 does the same for two more learners. Step 7's export
 * carries the mark and the re-upload reads it back on.
 *
 * **Reduced forms.** Each step a reduced build might leave out (the kill matrix,
 * the smoke and drill, bulk sign-off, export) is its own `describe`, so it can
 * be removed alone. Only the first two have a switch in the product
 * (`DEEP_VALIDATION_SCOPE`, read by `WRITTEN` below). A step
 * whose predecessor was left out opens its phase by the teacher's reopen
 * lever (as the a11y fixture does), records that it did, and does not advance.
 */
const SPEC_IMPORT_MAX_BYTES = 6 * 1024 * 1024;

/**
 * The phases the journey uploads as WRITTEN tasks, never executable: the
 * product's deep-validation scope decides it. With
 * `DEEP_VALIDATION_SCOPE.mutants` false an uploaded executable Testing phase
 * can never publish, so the reduced form uploads Testing as a written task;
 * with `DEEP_VALIDATION_SCOPE.smoke` false, Deployment as a written runbook.
 * `JOURNEY_WRITTEN=testing,deployment` (inline) builds those forms without
 * changing the scope. A written Testing or Deployment is the retired markdown
 * kind, which the upload door now refuses by name (asserted in step 1), so a
 * run that builds one stops at the upload. The fixture folder is frozen: the
 * written forms are built in memory from its bytes.
 */
const WRITTEN: ReadonlySet<string> = new Set([
  ...(DEEP_VALIDATION_SCOPE.mutants ? [] : ['testing']),
  ...(DEEP_VALIDATION_SCOPE.smoke ? [] : ['deployment']),
  ...(process.env.JOURNEY_WRITTEN ?? '').split(',').map((one) => one.trim()).filter(Boolean),
]);

/** The Shelf pack as the journey uploads it: as it is, or with Testing and/or Deployment as written tasks. */
function shelfArchive(asWritten: ReadonlySet<string> = WRITTEN): Buffer {
  const entries = entriesOf(SHELF_DIR);
  if (!asWritten.size) return writeZip(entries);
  const text = (name: string) => entries.find((one) => one.name === name)!.data.toString('utf-8');
  const out = new Map(entries.map((one) => [one.name, one]));
  const put = (name: string, data: string) => out.set(name, { name, data: Buffer.from(data, 'utf-8') });
  const drop = (prefix: string) => [...out.keys()].filter((name) => name.startsWith(prefix)).forEach((name) => out.delete(name));
  // the folder layout (docs/authoring-format.md, "The archive layout"): the written file is an editable mount at its path under files/, and the brief is
  // the phase's own taskPanel
  const written = (dir: string, file: { path: string; body: string }, criterion: { key: string; title: string; description: string }, rules: object[]) => {
    const phase = JSON.parse(text(`${dir}/phase.json`));
    put(`${dir}/files/${file.path}`, file.body);
    put(`${dir}/phase.json`, JSON.stringify({
      title: phase.title, intro: phase.intro,
      artifactKind: 'markdown', canRun: false, taskPanel: phase.taskPanel, objectives: phase.objectives,
      rubric: { passThreshold: 70, criteria: [{ ...criterion, weight: 1 }] },
      checks: { kind: 'markdown', targets: [file.path], minWords: 30, minWordsCriterion: criterion.key, rules },
      assistant: phase.assistant,
    }, null, 2));
  };
  if (asWritten.has('testing')) {
    const dir = 'phases/04-testing';
    for (const sealed of ['reference/', 'impl/', 'mutants/', 'files/']) drop(`${dir}/${sealed}`);
    written(dir, { path: 'tests/test-plan.md', body: '# Test plan\n\n<!-- One Given / When / Then case per acceptance criterion of SH-1 to SH-4. -->\n' },
      { key: 'test_plan', title: 'Test plan', description: 'A case a tester could run for every acceptance criterion.' },
      [{ id: 'plan-cases', label: 'Cases use Given / When / Then', criterion: 'test_plan', pattern: '\\bGiven\\b[^\\n]{4,}\\bWhen\\b[^\\n]{4,}\\bThen\\b', flags: 'i', required: true, failDetail: 'Write each case on one line: Given <state>, When <action>, Then <result>.' }]);
  }
  if (asWritten.has('deployment')) {
    const dir = 'phases/05-deployment';
    drop(`${dir}/drill/`);
    drop(`${dir}/smoke/`);
    drop(`${dir}/files/api/Dockerfile`);
    const runbook = (JSON.parse(text(`${dir}/phase.json`)).checks.rules as { id: string; target?: string; pattern?: string }[])
      .filter((rule) => rule.target === RUNBOOK_JSON && rule.pattern)
      .map(({ target: _target, ...rule }) => ({ ...rule, criterion: 'runbook_quality' }));
    written(dir, { path: RUNBOOK_JSON, body: text(`${dir}/files/${RUNBOOK_JSON}`) },
      { key: 'runbook_quality', title: 'Runbook quality', description: 'Health check, rollback and the incident, written for someone who was not there.' }, runbook);
  }
  return writeZip([...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

/** TaskTrackr's name, paths and facts. */
const TASKTRACKR_WORDS = ['TaskTrackr', 'due_date', 'TASK_SELECT', 'CR-2', 'schema.sql', 'web/dist', 'completeTask', 'US-4', 'Dana'];

/**
 * `JOURNEY_STRICT` (inline, comma-separated). `1`: every allowance that is not
 * an accepted product rule is taken out: none is left, so `1` is green.
 * `SOL-DOOR`: the informational probe of the accepted door rule (the open
 * door is grepped for its own allowed marker too), red by design. `JA-1` is
 * accepted and does nothing (that grep is always strict).
 * Any other value is refused, so a typo never reads as a strict run.
 */
const STRICT_SET: ReadonlySet<string> = new Set((process.env.JOURNEY_STRICT ?? '').split(',').map((one) => one.trim()).filter(Boolean));
const STRICT_KNOWN: readonly string[] = ['1', 'SOL-DOOR', 'JA-1'];
const solDoorProbe = STRICT_SET.has('SOL-DOOR');

/** A line of a workspace a composed review must carry: the first with some length, in path order. */
function workspaceLine(workspace: Record<string, string> | undefined): string | undefined {
  for (const path of Object.keys(workspace ?? {}).sort()) {
    const line = workspace![path].split('\n').map((one) => one.trim()).find((one) => one.length >= 12);
    if (line) return line;
  }
  return undefined;
}

const bothWays = (bytes: Buffer): string => `${bytes.toString('utf-8')}\n${bytes.toString('latin1')}`;
/** The needles a body carries: raw, JSON-escaped, and inside any base64 run (the sealed-roles.e2e-spec.ts reader, copied). */
function needlesIn(raw: string | Buffer, needles: readonly string[]): string[] {
  const text = Buffer.isBuffer(raw) ? bothWays(raw) : raw;
  const decoded = (text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []).map((run) => bothWays(Buffer.from(run, 'base64'))).join('\n');
  return needles.filter((needle) => {
    const escaped = JSON.stringify(needle).slice(1, -1);
    return [needle, escaped].some((form) => text.includes(form) || decoded.includes(form));
  });
}

/** A phase's or a task's compiled grading store: an object with a `kind`. */
const isChecksStore = (value: unknown): boolean =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as { kind?: unknown }).kind === 'string';
const SEALED_STORE = '<compiled checks: the sealed store>';
function scrubbed(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((one) => scrubbed(one, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, one]) => [key, key === 'checks' && isChecksStore(one) ? SEALED_STORE : scrubbed(one, depth + 1)]),
  );
}

/** SH-5 as a story record that meets the shelf's floor: the sentence, three tagged criteria and one exclusion. */
const SH5_RECORD = serialiseStory({
  ...EMPTY_STORY,
  id: 'SH-5',
  title: 'See an author’s free books',
  persona: 'library member',
  capability: 'to see which of an author’s books are free to borrow right now',
  benefit: 'I only walk to the shelf for a book that is there',
  criteria: [
    { id: 'AC-1', given: 'an author with three books on the shelf', when: 'a member filters by that author', then: 'the member sees all three books marked free', tag: 'happy' },
    { id: 'AC-2', given: 'one of those books is on loan to another member', when: 'the member filters by that author', then: 'that book is shown as lent and the other two as free', tag: 'boundary' },
    { id: 'AC-3', given: 'an author with no books at all', when: 'a member filters by that author', then: 'the member sees an empty list and no error', tag: 'error' },
  ],
  scopeExclusions: ['Holding a book for a member while it is on loan'],
});

/** The shelf's design as the learner fills it in the Design room's forms: one entity, an operation per story, one decision. */
const SHELF_DESIGN = serialiseDesign({
  ...EMPTY_DESIGN,
  entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [], responsibilities: ['knows who has it on loan'], satisfies: ['SH-1'] }],
  operations: [
    { id: 'O1', name: 'listBooks', inputs: ['author'], returns: 'every book, in shelf order', errors: [], satisfies: ['SH-1'] },
    { id: 'O2', name: 'lendBook', inputs: ['id', 'borrower'], returns: 'the book with its borrower', errors: ['book_not_found', 'cannot_lend'], satisfies: ['SH-2'] },
    { id: 'O3', name: 'returnBook', inputs: ['id'], returns: 'the book, back on the shelf', errors: ['book_not_found', 'not_on_loan'], satisfies: ['SH-3'] },
  ],
  decisions: [{
    id: 'D1', title: 'Keep the shelf in memory', choice: 'an in-memory shelf', alternative: 'a database',
    rationale: 'The shelf is small and the tests need a fresh one each time.', tradeOff: 'The books are gone when the process stops.',
    status: 'accepted', satisfies: ['SH-1'],
  }],
  notes: 'JOURNEY design notes: the shelf is one entity and three operations, one per story.',
});
/** A valid record with one entity and nothing else, which fails the floor. */
const THIN_DESIGN = serialiseDesign({
  ...EMPTY_DESIGN,
  entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }],
});
/** The shelf's API contract: its four routes and the three refusals. */
const SHELF_CONTRACT = `${JSON.stringify({
  operations: [
    { id: 'listBooks', method: 'GET', path: '/api/books', summary: 'Every book, in shelf order, optionally filtered by author.', satisfies: 'SH-1', errors: [] },
    { id: 'addBook', method: 'POST', path: '/api/books', summary: 'Adds a book and answers it with its new id.', errors: [] },
    { id: 'lendBook', method: 'POST', path: '/api/books/{id}/lend', summary: 'Lends a book to the named borrower.', satisfies: 'SH-2', errors: ['book_not_found', 'cannot_lend'] },
    { id: 'returnBook', method: 'POST', path: '/api/books/{id}/return', summary: 'Puts a lent book back on the shelf.', satisfies: 'SH-3', errors: ['book_not_found', 'not_on_loan'] },
  ],
  errors: {
    book_not_found: { status: 404, meaning: 'No book has the id.' },
    cannot_lend: { status: 409, meaning: 'The book is already on loan, or the borrower is blank.' },
    not_on_loan: { status: 409, meaning: 'A book that is on the shelf was returned.' },
  },
}, null, 2)}\n`;

describe('a teacher uploads their own project and a learner walks it, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  let address = 0;
  /** Each request from its own address, so per-address gates measure the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.91.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });
  const crossSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));
  const priorCap = process.env.IMPORT_MAX_BYTES;

  /* ------------------------------ what is grepped ------------------------------ */

  /** The teacher's own sealed edits carry these, so a leak of the edit is a leak too. */
  const EDIT_MARKER = `JOURNEY-SEALED-EDIT-${stamp}`;
  const WEAK_MARKER = `JOURNEY-SEALED-WEAK-${stamp}`;
  const NEEDLES: string[] = [...Object.values(SHELF_MARKERS), EDIT_MARKER, WEAK_MARKER, ...TASKTRACKR_WORDS];
  /**
   * Lines the Shelf pack serves the learner, one per room, each from a file the room
   * serves READ-ONLY (so the learner's own edits cannot take it away; none is
   * in a sealed file): the positive control of the grep. Each grep asks for
   * the control of the room the learner stands in, among the bodies captured
   * since the previous grep.
   */
  const CONTROLS: Record<string, string> = {
    // the Requirements room serves the provided stories read-only, as the story block's providedStories
    requirements: 'to record who has borrowed a book',
    // the Design room serves the stories the design traces to, as the design block's stories
    design: 'As a librarian, I want to put a returned book back, so that the next member can borrow it.',
    implementation: 'SH-1: the shelf lists books by title, whatever order they arrived in.',
    testing: "The suite talks to the application through Flask's own test client rather",
    deployment: 'Start it with `python3 api/main.py` (the port comes from PORT, 8000 when it is',
    maintenance: 'CHG-1 moves the shelf from title order to the order a librarian shelves in:',
  };

  /**
   * The solution door (an accepted product rule; `workflow/solution.service.ts` →
   * `solution.reference.ts referenceFiles`). After the learner's own reviewed
   * pass the door answers the model answer: a `code` phase's door the
   * teacher's `solution` files, a `tests` phase's door the `reference` suite.
   * The one marker of the phase's own kind is what that door may hold, read
   * only after the pass; every other needle (the other kind's marker included)
   * stays forbidden there. Under the `SOL-DOOR` probe nothing is allowed.
   */
  const doorAllowedFor = (kind: string): string[] =>
    solDoorProbe ? [] : kind === 'code' ? [SHELF_MARKERS.solution] : kind === 'tests' ? [SHELF_MARKERS.reference] : [];

  const captured: { label: string; body: string }[] = [];
  /** Post-pass solution door bodies, each with the one marker its kind may hold. */
  const doorBodies: { label: string; body: string; allowed: string[] }[] = [];
  const aiBodies: { surface: string; body: string }[] = [];
  /** The requests the provider would have composed from the same arguments; `line` is a workspace line a review must carry. */
  const composed: { surface: string; body: string; line?: string; error?: string }[] = [];
  /** Where the previous grep stopped: each grep's positive controls read only what came after it. */
  const mark = { captured: 0, composed: 0 };
  const grepLog: {
    after: string; bodies: number; aiBodies: number; composed: number; doors: number; leaks: string[];
    control: string; controlFound: boolean; aiControl: string[]; doorAllowedSeen: number; where: string[];
  }[] = [];
  const textOf = (res: { text?: string; body?: unknown }) => (typeof res.text === 'string' && res.text.length ? res.text : JSON.stringify(res.body ?? null));
  const keep = (label: string, res: { text?: string; body?: unknown }) => {
    captured.push({ label, body: textOf(res) });
  };
  /**
   * The sealed grep: every captured learner body, every post-pass door body,
   * every AI argument and every composed request so far; the room's control
   * line is in a learner body captured since the previous grep, and every
   * composed review since then carries a line of its own workspace.
   */
  const sealedGrep = (after: string, room: keyof typeof CONTROLS) => {
    const leaks = [
      ...captured.flatMap((one) => needlesIn(one.body, NEEDLES).map((needle) => `${one.label}: ${needle}`)),
      ...doorBodies.flatMap((one) => needlesIn(one.body, NEEDLES.filter((needle) => !one.allowed.includes(needle))).map((needle) => `${one.label}: ${needle}`)),
      ...aiBodies.flatMap((one) => needlesIn(one.body, NEEDLES).map((needle) => `ai ${one.surface}: ${needle}`)),
      ...composed.flatMap((one) => [
        ...needlesIn(one.body, NEEDLES).map((needle) => `composed ${one.surface}: ${needle}`),
        ...(one.error ? [`composed ${one.surface}: the composer threw (${one.error})`] : []),
      ]),
    ];
    const control = CONTROLS[room];
    const controlFound = captured.slice(mark.captured).some((one) => needlesIn(one.body, [control]).length === 1);
    const fresh = composed.slice(mark.composed);
    const aiControl = [
      ...(fresh.length ? [] : ['no request was composed since the previous grep']),
      ...fresh.filter((one) => one.line !== undefined && needlesIn(one.body, [one.line]).length === 0).map((one) => `composed ${one.surface} lacks its workspace line`),
    ];
    const doorAllowedSeen = doorBodies.reduce((n, one) => n + needlesIn(one.body, [SHELF_MARKERS.solution, SHELF_MARKERS.reference]).length, 0);
    // where each leak sits (40 characters either side), so a red names its call site
    const where = [
      ...captured.map((one) => ({ ...one, needles: NEEDLES })),
      ...doorBodies.map((one) => ({ ...one, needles: NEEDLES.filter((needle) => !one.allowed.includes(needle)) })),
      ...aiBodies.map((one) => ({ label: `ai ${one.surface}`, body: one.body, needles: NEEDLES })),
      ...composed.map((one) => ({ label: `composed ${one.surface}`, body: one.body, needles: NEEDLES })),
    ].flatMap((one) =>
      one.needles.filter((needle) => one.body.includes(needle)).map((needle) => {
        const at = one.body.indexOf(needle);
        return `${one.label}: …${one.body.slice(Math.max(0, at - 40), at + needle.length + 40)}…`;
      }),
    );
    grepLog.push({ after, bodies: captured.length, aiBodies: aiBodies.length, composed: composed.length, doors: doorBodies.length, leaks, control: room, controlFound, aiControl, doorAllowedSeen, where });
    mark.captured = captured.length;
    mark.composed = composed.length;
    expect({ after, leaks }).toEqual({ after, leaks: [] });
    expect({ after, controlFound }).toEqual({ after, controlFound: true });
    expect({ after, aiControl }).toEqual({ after, aiControl: [] });
  };

  /* ------------------------------ the capturing AI stub ------------------------------ */

  /**
   * Compose a request the way the provider would, from the same arguments; a composer that throws is a red,
   * never a skip. The body is each message's text as the model would read it (not re-escaped), plus any schema.
   */
  const compose = (surface: string, build: () => { role: string; content: string }[] | { messages: { role: string; content: string }[]; schema: unknown }, line?: string) => {
    try {
      const built = build();
      const messages = Array.isArray(built) ? built : built.messages;
      const schema = Array.isArray(built) ? '' : `\n${JSON.stringify(built.schema)}`;
      composed.push({ surface, body: `${messages.map((one) => `${one.role}: ${one.content}`).join('\n')}${schema}`, line });
    } catch (error) {
      composed.push({ surface, body: '', error: (error as Error).message });
    }
  };
  const capturing = {
    available: true,
    name: 'mock-ai',
    chat: jest.fn(async (ctx: any) => {
      aiBodies.push({ surface: 'chat', body: JSON.stringify(scrubbed(ctx)) });
      const reply = await mockAiForRoutes.chat(ctx);
      // provider.chat: the draft request, the reviewer of that draft, and the one repair turn
      compose('guided.draft', () => composeChatMessages(ctx));
      compose('guided.review', () => composeGuidedReviewMessages(ctx, reply.content));
      // every repair note the reviewer can ask for (the composer refuses an empty or unknown list)
      compose('guided.repair', () => composeGuidedRepairMessages(ctx, reply.content, ['limited_step', 'grounded', 'learner_reasoning'], []));
      return reply;
    }),
    interview: jest.fn(async (...args: any[]) => {
      aiBodies.push({ surface: 'interview', body: JSON.stringify(scrubbed(args)) });
      compose('interview', () => composeInterviewMessages(args[0], args[1], args[2], args[3]));
      return (mockAiForRoutes.interview as any)(...args);
    }),
    reviewInterview: jest.fn(async (...args: any[]) => {
      // its composer is not exported: the arguments are what is grepped
      aiBodies.push({ surface: 'reviewInterview', body: JSON.stringify(scrubbed(args)) });
      return (mockAiForRoutes.reviewInterview as any)(...args);
    }),
    review: jest.fn(async (phase: any, input: any) => {
      aiBodies.push({ surface: `review ${phase?.key}`, body: JSON.stringify(scrubbed([phase, input])) });
      compose(`grading.review ${phase?.key}`, () => ({ messages: composeReviewMessages(phase, input), schema: reviewResponseSchema(phase, input) }), workspaceLine(input?.workspace));
      return mockAiForRoutes.review(phase, input);
    }),
  };

  /* ------------------------------ the stub sandbox ------------------------------ */

  const payloads: Record<string, unknown>[] = [];
  let judged: CompiledSnapshot | null = null;
  /** The learner's finished files per code phase (written in step 5, read by the judge). */
  const finished: Record<string, Record<string, string>> = {};
  /** The suite that asserts nothing (step 2's first edit); its bytes are known before the app boots. */
  const WEAK_SUITE = `"""${WEAK_MARKER}"""\nimport unittest\n\n\nclass Shelf(unittest.TestCase):\n    def test_anything(self):\n        self.assertTrue(True)\n`;
  const FAILING_CASE: TestCaseResult = {
    name: 'test_lend_refuses_a_book_already_on_loan',
    status: 'failed',
    message: 'AssertionError: 200 != 409',
    frames: [{ path: 'api/shelf.py', line: 52 }],
  };
  const ok = (n = 4): RunResult => ({ ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1, tests: { total: n, passed: n, failed: 0, errored: 0, cases: [] } });
  // A suite that ran and failed: the process exited normally (`exitKind` 'ok'), its tests did not
  // (`error` is the harness itself failing, which the grader never counts as a kill).
  const bad = (n = 4): RunResult => ({
    ok: false, exitKind: 'ok', stdout: '', stderr: '', durationMs: 1,
    tests: { total: n, passed: n - 1, failed: 1, errored: 0, cases: [FAILING_CASE] },
  });
  const same = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n') && Object.keys(a).every((k) => a[k] === b[k]);
  const judge = (job: SandboxJob): RunResult => {
    const phases = judged?.content.phases ?? [];
    if (job.mode === 'smoke') {
      const drill = phases.map((p) => (p.checks.kind === 'config' ? (p.checks as ConfigChecks).drill : undefined)).find(Boolean);
      const faulted = drill && Object.entries(drill.faultedFiles).some(([at, bytes]) => job.files[at] === bytes);
      return { ok: !faulted, exitKind: faulted ? 'error' : 'ok', stdout: '', stderr: '', durationMs: 1 };
    }
    if (job.gradedFiles) {
      const tests = phases.find((p) => p.checks.kind === 'tests')?.checks as TestsChecks | undefined;
      return tests?.runs.some((run) => same(job.gradedFiles!, run.implFiles)) ? ok() : bad();
    }
    // a suite that asserts nothing passes whatever it is run against
    if (Object.values(job.files).some((bytes) => bytes === WEAK_SUITE)) return ok();
    const code = phases.filter((p) => p.checks.kind === 'code').map((p) => p.checks as CodeChecks);
    const targets = [...new Set(code.flatMap((checks) => checks.editableTargets ?? []))];
    const good = new Set<string>([
      ...code.flatMap((checks) => Object.values(checks.solutionFiles)),
      ...Object.values(finished).flatMap((files) => Object.values(files)),
    ]);
    const held = targets.filter((at) => job.files[at] !== undefined);
    return held.length > 0 && held.every((at) => good.has(job.files[at])) ? ok() : bad();
  };

  /* ------------------------------ the people ------------------------------ */

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `${name}-${stamp}@journey.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  let teacher = { id: '', token: '' };
  let learner = { id: '', token: '' };
  let projectId = '';
  let versionId = '';
  let slug = '';
  let publishedVersionId = '';
  let cohortId = '';
  let joinCode = '';
  let base = '';
  let hiddenPath = '';
  let shippedSuite = '';
  let strongSuite = '';
  /** The published version's compiled task list, kept at publish (step 7 compares the re-upload with it). */
  let publishedTaskList: unknown = null;
  let learnerPhases: Record<string, string> = {};
  /** Steps whose phase was opened by the teacher's lever because the step before was cut. */
  const openedByLever: string[] = [];
  /** The learner steps that ran (a cut form reverses some). */
  const ran = new Set<string>();
  let chain = true;

  /** The task list as a learner is graded on it: every phase's tasks, the sole key as a pack says it. */
  const taskListOf = (snapshot: CompiledSnapshot): unknown =>
    JSON.parse(canonicalJson(snapshot.phases.map((phase) => ({ key: phase.key, tasks: phase.tasks.map((task) => ({ ...task, taskKey: task.taskKey === INHERITED_TASK_KEY ? '' : task.taskKey })) }))));

  const snapshotOf = async (id: string): Promise<CompiledSnapshot> =>
    (await db.manager.findOneByOrFail(ProjectVersionEntity, { id })).compiled as CompiledSnapshot;

  /* ------------------------------ the learner's doors ------------------------------ */

  const learnerGet = async (label: string, url: string, who = learner) => {
    const res = await request(http).get(`/api/v1${url}`).set(bearer(who.token)).set(from());
    expect({ label, status: res.status }).toEqual({ label, status: 200 });
    keep(label, res);
    return res.body;
  };

  const save = async (key: string, files: Record<string, string>, who = learner, phases = learnerPhases) => {
    const res = await request(http).put(`/api/v1/phases/${phases[key]}/workspace`).set(bearer(who.token)).set(from()).send({ files });
    expect({ key, status: res.status, message: res.status === 200 ? null : res.body?.message }).toEqual({ key, status: 200, message: null });
  };

  const run = async (key: string) => {
    const started = await request(http).post(`/api/v1/phases/${learnerPhases[key]}/run`).set(bearer(learner.token)).set(from());
    expect({ key, status: started.status, message: started.status < 300 ? null : started.body?.message }).toEqual({ key, status: 201, message: null });
    keep(`${key} run started`, started);
    for (let i = 0; i < 200; i++) {
      const read = await request(http).get(`/api/v1/runs/${started.body.id}`).set(bearer(learner.token)).set(from());
      expect(read.status).toBe(200);
      if (read.body.status === 'completed' || read.body.status === 'failed') {
        keep(`${key} run`, read);
        return read.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the ${key} run did not finish`);
  };

  const submit = async (key: string, who = learner, phases = learnerPhases) => {
    const submitted = await request(http).post(`/api/v1/phases/${phases[key]}/submit`).set(bearer(who.token)).set(from());
    expect({ key, status: submitted.status, message: submitted.status < 300 ? null : submitted.body?.message }).toEqual({ key, status: 201, message: null });
    keep(`${key} submit`, submitted);
    for (let i = 0; i < 300; i++) {
      const read = await request(http).get(`/api/v1/submissions/${submitted.body.id}`).set(bearer(who.token)).set(from());
      expect(read.status).toBe(200);
      if (read.body.status === 'completed' || read.body.status === 'failed') {
        keep(`${key} feedback`, read);
        const full = await request(http).get(`/api/v1/submissions/${submitted.body.id}?include=snapshot`).set(bearer(who.token)).set(from()).expect(200);
        keep(`${key} feedback with files`, full);
        return read.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the ${key} submission did not finish`);
  };

  /** A verdict that passed, or the checks and the review that held it back. */
  const expectPassed = (verdict: any) => {
    const held = ((verdict?.report?.checks ?? []) as { id: string; status: string }[]).filter((one) => one.status !== 'passed' && one.status !== 'info');
    expect({ passed: verdict?.passed, status: verdict?.status, held: held.map((one) => `${one.id}:${one.status}`), review: verdict?.report?.aiReview?.verdict ?? null })
      .toEqual({ passed: true, status: 'completed', held: [], review: expect.anything() });
  };

  /** Everything else the learner reads about a phase after a verdict: the room, its history, the records. */
  const readRoom = async (key: string) => {
    await learnerGet(`${key} room`, `/phases/${learnerPhases[key]}`);
    await learnerGet(`${key} submissions`, `/phases/${learnerPhases[key]}/submissions`);
    await learnerGet(`${key} runs`, `/phases/${learnerPhases[key]}/runs`);
    await learnerGet('records', '/phases/records');
    await learnerGet('summaries', '/phases/summaries');
  };

  const statusOf = async (key: string, phases = learnerPhases) =>
    (await db.manager.findOneByOrFail(PhaseStateEntity, { id: phases[key] })).status;

  /** Open a phase the learner is about to work: by advancing from a passed predecessor, or (a cut form) by the lever. */
  const reach = async (key: string) => {
    if ((await statusOf(key)) === 'in_progress') return;
    chain = false;
    openedByLever.push(key);
    const res = await request(http)
      .post(`/api/v1/instructor/learners/${learner.id}/phases/${learnerPhases[key]}/override`)
      .set(bearer(teacher.token))
      .set(from())
      .send({ action: 'reopen', reason: 'Opened for the journey: the step before it was cut.' });
    expect({ key, status: res.status }).toEqual({ key, status: 200 });
  };

  /** A pass moves the learner on, when the road behind them is whole. */
  const advance = async (key: string) => {
    if (!chain) return;
    const res = await request(http).post(`/api/v1/phases/${learnerPhases[key]}/advance`).set(bearer(learner.token)).set(from());
    expect({ key, status: res.status, message: res.status < 300 ? null : res.body?.message }).toEqual({ key, status: 201, message: null });
  };

  /* ------------------------------ the countersignature ------------------------------ */

  const signoffRoute = (key: keyof typeof SIGNOFF_ROUTES) => `/api/v1${SIGNOFF_ROUTES[key].path.replace(':cohortId', cohortId)}`;
  /** The class's sign-off queue, as the teacher reads it. */
  const queueOf = async (): Promise<SignoffQueueView> =>
    (await request(http).get(signoffRoute('signoff.queue')).set(bearer(teacher.token)).set(from()).expect(200)).body as SignoffQueueView;
  const bulkRows = async (userId: string) =>
    (await db.manager.find(AuditEventEntity, { where: { subjectUserId: userId } })).filter((one) => one.event === 'class.bulk-signoff');
  /**
   * The learner's own pass of a task the teacher marked (step 4) waits for the
   * countersignature: the phase is not passed and its door stays shut; the
   * queue lists the learner on that task; an empty reason is refused with no
   * audit row; one reason signs them off with exactly one `class.bulk-signoff`
   * row, and the phase is passed.
   */
  const countersign = async (key: string) => {
    expect({ key, status: await statusOf(key) }).toEqual({ key, status: expect.not.stringMatching(/^passed$/) });
    await doorShut(key);
    const waiting = (await queueOf()).rows.filter((one) => one.userId === learner.id);
    expect(waiting.map((one) => [one.phaseKey, one.taskKey])).toEqual([[key, INHERITED_TASK_KEY]]);
    const batch = { phaseKey: key, taskKey: INHERITED_TASK_KEY, userIds: [learner.id] };
    const empty = await request(http).post(signoffRoute('signoff.bulk')).set(bearer(teacher.token)).set(from()).send({ ...batch, reason: '' });
    expect(empty.status).toBe(400);
    expect(await bulkRows(learner.id)).toEqual([]);
    const signed = await request(http).post(signoffRoute('signoff.bulk')).set(bearer(teacher.token)).set(from())
      .send({ ...batch, reason: 'Read the story with the learner in the lab: the criteria are testable.' });
    expect({ status: signed.status, message: signed.status < 300 ? null : signed.body?.message }).toEqual({ status: 200, message: null });
    expect((signed.body as BulkSignoffResult).signedOff).toEqual([learner.id]);
    expect((await bulkRows(learner.id)).map((one) => one.actorUserId)).toEqual([teacher.id]);
    expect({ key, status: await statusOf(key) }).toEqual({ key, status: 'passed' });
    expect((await queueOf()).rows.filter((one) => one.userId === learner.id)).toEqual([]);
  };

  /** The solution door's two routes for a phase: the phase-level one and its sole task's. */
  const doorUrls = (key: string) => {
    const taskKey = judged!.phases.find((one) => one.key === key)!.tasks[0].taskKey;
    return [`/phases/${learnerPhases[key]}/solution`, `/phases/${learnerPhases[key]}/tasks/${taskKey}/solution`];
  };
  /** Before the learner's own pass the door is shut, in its own sentence; the refusal is a learner body like any other. */
  const doorShut = async (key: string) => {
    for (const url of doorUrls(key)) {
      const res = await request(http).get(`/api/v1${url}`).set(bearer(learner.token)).set(from());
      expect({ key, url: url.replace(/^\/phases\/[^/]+/, ''), status: res.status, message: res.body?.message }).toEqual({ key, url: url.replace(/^\/phases\/[^/]+/, ''), status: 403, message: SOLUTION_LOCKED_MESSAGE });
      keep(`${key} solution door (shut)`, res);
    }
  };
  /**
   * After the pass the door opens (the accepted solution-door rule): a code or tests
   * phase answers its model answer, so its one allowed marker must be there (the
   * rule is exercised, not assumed) and the other kind's must not; a written or
   * config phase answers nothing.
   */
  const doorOpen = async (key: string) => {
    const kind = judged!.content.phases.find((one) => one.key === key)!.checks.kind;
    for (const url of doorUrls(key)) {
      const res = await request(http).get(`/api/v1${url}`).set(bearer(learner.token)).set(from());
      expect({ key, status: res.status }).toEqual({ key, status: 200 });
      doorBodies.push({ label: `${key} solution door (open)`, body: textOf(res), allowed: doorAllowedFor(kind) });
      const answered = kind === 'code' ? SHELF_MARKERS.solution : kind === 'tests' ? SHELF_MARKERS.reference : null;
      expect({ key, available: res.body.available, answered: answered ? needlesIn(res.text, [answered]) : [] })
        .toEqual({ key, available: answered !== null, answered: answered ? [answered] : [] });
    }
  };

  /* ------------------------------ boot ------------------------------ */

  beforeAll(async () => {
    process.env.IMPORT_MAX_BYTES = String(SPEC_IMPORT_MAX_BYTES);
    jest.spyOn(SandboxService.prototype as any, 'runPython').mockImplementation(async (...args: unknown[]) => {
      const payload = args[1] as Record<string, unknown>;
      if (String(args[0]).endsWith('analyzer.py')) {
        return JSON.stringify({ issues: [], metrics: { files: 1, functions: 1, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 } });
      }
      payloads.push(payload);
      return JSON.stringify(judge(payload as unknown as SandboxJob));
    });
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    // One listening server on loopback, an ephemeral port, closed by app.close.
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, capturing]], trustProxy: true, listen: true }));
    db = app.get(DataSource);
    teacher = await account('journey-teacher', 'INSTRUCTOR');
    learner = await account('journey-learner');
  }, 120000);

  afterAll(async () => {
    if (process.env.JOURNEY_OUT) {
      fs.writeFileSync(
        process.env.JOURNEY_OUT,
        JSON.stringify({ strict: [...STRICT_SET], solDoorProbe, written: [...WRITTEN], ran: [...ran], composedSurfaces: composed.map((one) => `${one.surface}${one.line === undefined ? '' : ' (line)'}`), doors: doorBodies.map((one) => one.label), grepLog, openedByLever, aiSurfaces: aiBodies.map((one) => one.surface), captured: captured.map((one) => one.label), jobs: payloads.length }, null, 1),
        { mode: 0o600 },
      );
    }
    jest.restoreAllMocks();
    await app?.close();
    if (priorCap === undefined) delete process.env.IMPORT_MAX_BYTES;
    else process.env.IMPORT_MAX_BYTES = priorCap;
  });

  it('confirms the capturing stub stands in for the provider before anything is driven (m8)', () => {
    expect({ unknownStrict: [...STRICT_SET].filter((one) => !STRICT_KNOWN.includes(one)) }).toEqual({ unknownStrict: [] });
    expect(app.get(OpenAiProvider)).toBe(capturing);
    expect(http.address()).toEqual(expect.objectContaining({ address: '127.0.0.1' }));
  });

  /* ------------------------------ 1. upload ------------------------------ */

  describe('1. the teacher uploads the Shelf pack', () => {
    it('→ a written Testing (the retired markdown kind) is refused by name in the NOT_A_PACK detail, and nothing is written', async () => {
      const before = await db.manager.count(ProjectVersionEntity);
      const refused = await request(http)
        .post(UPLOAD_PATH)
        .set(bearer(teacher.token))
        .set(from())
        .send({ title: `Shelf written Testing ${stamp}`, archiveBase64: shelfArchive(new Set(['testing'])).toString('base64') });
      expect({ status: refused.status, code: refused.body?.code }).toEqual({ status: 400, code: 'NOT_A_PACK' });
      expect(String(refused.body?.detail)).toContain(retiredWrittenPhaseUploadRefusal('Testing'));
      expect(await db.manager.count(ProjectVersionEntity)).toBe(before);
    });

    it('→ a draft owned by the teacher, fast validation clean, one project.uploaded audit row', async () => {
      const uploaded = await request(http)
        .post(UPLOAD_PATH)
        .set(bearer(teacher.token))
        .set(from())
        .send({ title: `Shelf journey ${stamp}`, archiveBase64: shelfArchive().toString('base64') });
      expect({ status: uploaded.status, code: uploaded.body?.code, message: uploaded.status === 201 ? null : uploaded.body?.message }).toEqual({ status: 201, code: undefined, message: null });
      projectId = uploaded.body.projectId;
      versionId = uploaded.body.versionId;
      slug = uploaded.body.slug;
      base = `/api/v1/instructor/projects/${projectId}/versions/${versionId}`;
      expect(uploaded.body.validation.blocking).toEqual([]);
      expect(needlesIn(uploaded.text, NEEDLES)).toEqual([]);
      const version = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId });
      expect(version.status).toBe('draft');
      const audit = (await db.manager.find(AuditEventEntity, { where: { targetId: projectId } })).filter((row) => row.event === 'project.uploaded');
      expect(audit.map((row) => [row.actorUserId, row.action])).toEqual([[teacher.id, slug]]);
    });
  });

  /* ------------------------------ 2. the sealed edit ------------------------------ */

  describe('2. the teacher edits Implementation’s hidden suite', () => {
    it('→ through the sealed door, which answers a digest and size, never the bytes', async () => {
      const phase = await db.manager.findOneByOrFail(ProjectPhaseEntity, { projectVersionId: versionId, key: 'implementation' });
      const rows = await db.manager.find(ProjectFileEntity, { where: { projectVersionId: versionId, ownerId: phase.id, role: 'hidden' } });
      const py = rows.find((one) => one.path.endsWith('.py'))!;
      hiddenPath = py.path.slice('hidden/'.length);
      const draft = await snapshotOf(versionId);
      const runOf = (snapshot: CompiledSnapshot) =>
        (snapshot.content.phases.find((one) => one.key === 'implementation')!.checks as CodeChecks).runs.find((one) => one.hiddenTestFiles[hiddenPath] !== undefined)!;
      shippedSuite = runOf(draft).hiddenTestFiles[hiddenPath];
      expect(shippedSuite).toContain(SHELF_MARKERS.hidden);
      // The first edit: a suite that asserts nothing (the mistake step 3 catches).
      const wrote = await request(http)
        .put(`${base}/phases/implementation/tasks/${INHERITED_TASK_KEY}/sealed`)
        .set(bearer(teacher.token))
        .set(from())
        .send({ role: 'hidden', runId: null, path: hiddenPath, contentBase64: Buffer.from(WEAK_SUITE).toString('base64') });
      expect({ status: wrote.status, message: wrote.status === 200 ? null : wrote.body?.message }).toEqual({ status: 200, message: null });
      expect(Object.keys(wrote.body).sort()).toEqual(['bytes', 'path', 'sha256']);
      expect(needlesIn(wrote.text, NEEDLES)).toEqual([]);
      const validated = await request(http).post(`${base}/validate`).set(bearer(teacher.token)).set(from()).expect(200);
      expect(validated.body.blocking).toEqual([]);
      expect(runOf(await snapshotOf(versionId)).hiddenTestFiles[hiddenPath]).toBe(WEAK_SUITE);
      // a run the phase does not declare is refused by the sealed door's sentence
      const refused = await request(http)
        .put(`${base}/phases/implementation/tasks/${INHERITED_TASK_KEY}/sealed`)
        .set(bearer(teacher.token))
        .set(from())
        .send({ role: 'hidden', runId: 'no-such-run', path: hiddenPath, contentBase64: Buffer.from(WEAK_SUITE).toString('base64') });
      expect(refused.status).toBe(400);
      expect(String(refused.body.message)).toContain(SEALED_REFUSALS.run);
    });
  });

  /* ------------------------------ 3. deep validation ------------------------------ */

  describe('3. deep validation', () => {
    const deep = () => `${base}/deep-validation`;
    const prove = async () => {
      judged = await snapshotOf(versionId);
      const cost = await request(http).get(deep()).set(bearer(teacher.token)).set(from()).expect(200);
      expect(cost.body.costWarning.microVMs).toBeGreaterThan(0);
      await request(http).post(deep()).set(bearer(teacher.token)).set(from()).send({ acknowledgedMicroVMs: cost.body.costWarning.microVMs }).expect(202);
      await app.get(DeepValidationService).idle();
      const view = await request(http).get(deep()).set(bearer(teacher.token)).set(from()).expect(200);
      expect(needlesIn(view.text, NEEDLES)).toEqual([]);
      return view.body;
    };

    it('→ refuses first: the edited suite asserts nothing, so the starter already passes it (its own sentence); publish refuses too', async () => {
      const view = await prove();
      expect(view.status).toBe('failed');
      const starter = (view.checks as { id: string; status: string; sentence: string }[]).find((one) => one.id === 'starter-fails-hidden')!;
      expect(starter.status).toBe('failed');
      expect(starter.sentence).toBe('In Implementation, the starter already passes the hidden suite on the API tests run, so a learner could pass without writing anything.');
      expect(hasCurrentDeepReceipt(await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId }))).toBe(false);
      const refused = await request(http).post(`${base}/publish`).set(bearer(teacher.token)).set(from()).send({ version: '1.0.0' }).expect(400);
      expect(String(refused.body.message)).toContain(deepReceiptRefusal('Implementation', { uploaded: true }));
    });

    it('→ the teacher writes a suite with teeth, and deep validation passes with its receipt stored', async () => {
      strongSuite = `${shippedSuite}\n# ${EDIT_MARKER}: one more sealed case the teacher added\n`;
      await request(http)
        .put(`${base}/phases/implementation/tasks/${INHERITED_TASK_KEY}/sealed`)
        .set(bearer(teacher.token))
        .set(from())
        .send({ role: 'hidden', runId: null, path: hiddenPath, contentBase64: Buffer.from(strongSuite).toString('base64') })
        .expect(200);
      await request(http).post(`${base}/validate`).set(bearer(teacher.token)).set(from()).expect(200);
      const view = await prove();
      expect({ status: view.status, current: view.current }).toEqual({ status: 'passed', current: true });
      expect((view.checks as { id: string; status: string }[]).filter((one) => one.status === 'failed')).toEqual([]);
      const version = await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId });
      expect(hasCurrentDeepReceipt(version)).toBe(true);
      expect((version.validation as { deep?: { status?: string } }).deep?.status).toBe('passed');
    });
  });

  /* ------------------------------ 4. publish, assign ------------------------------ */

  describe('4. publish within the ceiling, and assign', () => {
    it('→ the version publishes inside the ceiling; every executable phase is AUTHORED; a class runs it', async () => {
      const draft = await snapshotOf(versionId);
      const prices = draft.content.phases.map((phase) => ({
        key: phase.key,
        microVMs: sandboxBudgetFor(phase, draft.phases.find((one) => one.key === phase.key)!.tasks),
      }));
      for (const one of prices) expect({ key: one.key, within: one.microVMs <= BUDGET_CEILING.perPhase }).toEqual({ key: one.key, within: true });
      expect(prices.reduce((n, one) => n + one.microVMs, 0)).toBeLessThanOrEqual(BUDGET_CEILING.perVersion);

      // the teacher marks Requirements' sole task through the editor route, on the draft
      const marked = await request(http).patch(`${base}/phases/requirements/tasks/${INHERITED_TASK_KEY}`).set(bearer(teacher.token)).set(from()).send({ signOff: true });
      expect({ status: marked.status, message: marked.status === 200 ? null : marked.body?.message }).toEqual({ status: 200, message: null });
      expect((marked.body.phase.tasks as { taskKey: string; signOff?: boolean }[]).map((one) => [one.taskKey, one.signOff === true])).toEqual([[INHERITED_TASK_KEY, true]]);
      expect(needlesIn(marked.text, NEEDLES)).toEqual([]);
      expect((await snapshotOf(versionId)).phases.map((one) => [one.key, one.tasks.map((task) => task.signOff)])).toEqual(
        ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'].map((key) => [key, [key === 'requirements']]),
      );

      const published = await request(http).post(`${base}/publish`).set(bearer(teacher.token)).set(from()).send({ version: '1.0.0' });
      expect({ status: published.status, message: published.status === 200 ? null : published.body?.message }).toEqual({ status: 200, message: null });
      publishedVersionId = published.body.versionId;
      const live = await snapshotOf(publishedVersionId);
      publishedTaskList = taskListOf(live);
      expect(live.phases.find((one) => one.key === 'requirements')!.tasks.map((task) => task.signOff)).toEqual([true]);
      // the published executable phases are the teacher's, so their reviewer is AUTHORED
      for (const phase of live.content.phases.filter((one) => ['code', 'tests', 'config'].includes(one.checks.kind))) {
        const tasks = live.phases.find((one) => one.key === phase.key)!.tasks;
        expect({ key: phase.key, scope: taskScopeOf(phase).kind, task: taskScopeOf(phase, tasks[0], tasks).kind }).toEqual({ key: phase.key, scope: 'authored', task: 'authored' });
      }
      // the live implementation grades against the teacher's suite
      const implementation = live.content.phases.find((one) => one.key === 'implementation')!;
      expect((implementation.checks as CodeChecks).runs.find((one) => one.hiddenTestFiles[hiddenPath] !== undefined)!.hiddenTestFiles[hiddenPath]).toBe(strongSuite);

      const made = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).set(from()).send({ name: 'Shelf journey class' }).expect(201);
      cohortId = made.body.id;
      joinCode = made.body.joinCode;
      await request(http)
        .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
        .set(bearer(teacher.token))
        .set(from())
        .send({ projectVersionId: publishedVersionId, reason: 'This class runs the shelf this term.' })
        .expect(200);
      await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).set(from()).send({ code: joinCode }).expect(200);
      const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner.token)).set(from()).send({ projectSlug: slug }).expect(201);
      keep('enrolment', enrolled);
      learnerPhases = Object.fromEntries((enrolled.body.phases as { key: string; id: string }[]).map((one) => [one.key, one.id]));
      expect(Object.keys(learnerPhases).sort()).toEqual(['deployment', 'design', 'implementation', 'maintenance', 'requirements', 'testing']);
      judged = live;
    });
  });

  /* ------------------------------ 5. the learner ------------------------------ */

  describe('5. the learner', () => {
    it('→ Requirements fails, then passes, through the capturing AI stub', async () => {
      ran.add('requirements');
      const room = await learnerGet('requirements room', `/phases/${learnerPhases.requirements}`);
      const record = (room.files as { path: string; content: string }[]).find((one) => one.path === 'requirements/story.json')!;
      expect(record).toBeDefined();
      // the seeded record with a title only: still short of the floor
      await save('requirements', { 'requirements/story.json': serialiseStory({ ...JSON.parse(record.content), title: 'A member wants the free books' }) });
      const failed = await submit('requirements');
      expect(failed.passed).toBe(false);
      await readRoom('requirements');
      await doorShut('requirements');
      // a failed attempt puts nobody in the queue
      expect((await queueOf()).rows.filter((one) => one.userId === learner.id)).toEqual([]);
      sealedGrep('requirements fail', 'requirements');
      await crossSecond();
      await save('requirements', { 'requirements/story.json': SH5_RECORD });
      const passed = await submit('requirements');
      expectPassed(passed);
      await readRoom('requirements');
      // the task is marked: the pass waits for the teacher, who signs it off in bulk right here
      await countersign('requirements');
      await readRoom('requirements');
      await doorOpen('requirements');
      sealedGrep('requirements pass', 'requirements');
      await advance('requirements');
    }, 120000);

    it('→ Design fails, then passes, through the capturing AI stub', async () => {
      await reach('design');
      ran.add('design');
      await learnerGet('design room', `/phases/${learnerPhases.design}`);
      // a valid record with one entity and nothing else: short of the floor
      await save('design', { [DESIGN_JSON]: THIN_DESIGN });
      const failed = await submit('design');
      expect(failed.passed).toBe(false);
      await readRoom('design');
      await doorShut('design');
      sealedGrep('design fail', 'design');
      await crossSecond();
      await save('design', { [DESIGN_JSON]: SHELF_DESIGN, [API_CONTRACT_JSON]: SHELF_CONTRACT });
      const passed = await submit('design');
      expectPassed(passed);
      await readRoom('design');
      await doorOpen('design');
      sealedGrep('design pass', 'design');
      await advance('design');
    }, 120000);

    it('→ Implementation fails, then passes, graded against the teacher’s edited suite; the mentor and explain answer without a sealed byte', async () => {
      await reach('implementation');
      ran.add('implementation');
      const room = await learnerGet('implementation room', `/phases/${learnerPhases.implementation}`);
      const files = Object.fromEntries((room.files as { path: string; content: string }[]).map((one) => [one.path, one.content]));
      expect(needlesIn(JSON.stringify(room), [CONTROLS.implementation])).toEqual([CONTROLS.implementation]);
      // first: the starter as served, run and handed in
      await run('implementation');
      payloads.length = 0;
      const failed = await submit('implementation');
      expect(failed.passed).toBe(false);
      const graded = payloads.filter((one) => (one.files as Record<string, string> | undefined)?.[hiddenPath] !== undefined);
      expect(graded.length).toBeGreaterThan(0);
      for (const job of graded) expect((job.files as Record<string, string>)[hiddenPath]).toBe(strongSuite);
      await readRoom('implementation');
      // the mentor, and "explain this failing test" on the failed submission
      const mentor = await request(http).post('/api/v1/assistant/chat').set(bearer(learner.token)).set(from())
        .send({ phaseStateId: learnerPhases.implementation, message: 'Why does lending fail for a book that is already out?' });
      expect({ status: mentor.status, message: mentor.status < 300 ? null : mentor.body?.message }).toEqual({ status: 201, message: null });
      keep('implementation mentor', mentor);
      const explained = await request(http).post(`/api/v1/phases/${learnerPhases.implementation}/explain-test`).set(bearer(learner.token)).set(from())
        .send({ testName: FAILING_CASE.name, source: 'submission', sourceId: failed.id });
      expect({ status: explained.status, message: explained.status < 300 ? null : explained.body?.message }).toEqual({ status: 200, message: null });
      keep('implementation explain', explained);
      await learnerGet('implementation mentor history', `/assistant/history/${learnerPhases.implementation}`);
      await doorShut('implementation');
      sealedGrep('implementation fail', 'implementation');

      // then: the learner's own finished files (no byte of the reference solution)
      const py = files['api/shelf.py'];
      const ts = files['web/src/lib/shelf.ts'];
      const donePy = py
        .replace(
          '        # TODO(learner): filter by author (ignoring case and spaces), then order by title, then id.\n        raise NotImplementedError("books is not implemented yet")',
          '        wanted = (author or "").strip().lower()\n        found = [b for b in self._books.values() if not wanted or b["author"].strip().lower() == wanted]\n        return [dict(b) for b in sorted(found, key=lambda b: (b["title"].lower(), b["id"]))]',
        )
        .replace(
          '        # TODO(learner): refuse an unknown id, a blank borrower and a book already on loan.\n        raise NotImplementedError("lend is not implemented yet")',
          '        if book_id not in self._books:\n            raise KeyError(book_id)\n        if not (borrower or "").strip():\n            raise ValueError("a loan needs a borrower")\n        book = self._books[book_id]\n        if book["on_loan_to"] is not None:\n            raise ValueError("that book is already on loan")\n        book["on_loan_to"] = borrower.strip()\n        return dict(book)',
        );
      const doneTs = ts
        .replace(
          "  // TODO(learner): \"Title — Author (year)\", no year when it is null, \" · on loan\" while lent.\n  throw new Error('shelfLabel is not implemented yet');",
          "  const year = book.year === null ? '' : ` (${book.year})`;\n  return `${book.title} — ${book.author}${year}${book.on_loan_to ? ' · on loan' : ''}`;",
        )
        .replace(
          "  // TODO(learner): a new array, by title ignoring case, then by id.\n  throw new Error('sortForShelf is not implemented yet');",
          '  return [...books].sort((a, b) => byText(a.title.toLowerCase(), b.title.toLowerCase()) || a.id - b.id);',
        );
      expect([donePy !== py, doneTs !== ts, /TODO\(learner\)/.test(donePy + doneTs)]).toEqual([true, true, false]);
      finished.implementation = { 'api/shelf.py': donePy, 'web/src/lib/shelf.ts': doneTs };
      await crossSecond();
      await save('implementation', finished.implementation);
      await run('implementation');
      payloads.length = 0;
      const passed = await submit('implementation');
      expectPassed(passed);
      const hiddenRow = (passed.report.checks as { id: string; status: string }[]).find((one) => one.id === 'hidden-tests-api');
      expect(hiddenRow?.status).toBe('passed');
      const gradedAgain = payloads.filter((one) => (one.files as Record<string, string> | undefined)?.[hiddenPath] !== undefined);
      expect(gradedAgain.length).toBeGreaterThan(0);
      for (const job of gradedAgain) expect((job.files as Record<string, string>)[hiddenPath]).toBe(strongSuite);
      expect(JSON.stringify(payloads)).not.toContain(JSON.stringify(shippedSuite));
      await readRoom('implementation');
      await doorOpen('implementation');
      sealedGrep('implementation pass', 'implementation');
      await advance('implementation');
    }, 180000);

    describe('Testing', () => {
      // The stub judge decides each run (a tests job passes on the reference implementation and fails on a mutant),
      // so what this proves is the route: the enough-tests refusal, then a matrix with a row and a kill per mutant.
      it('→ Testing fails the enough-tests check with no suite; with the learner’s suite the kill matrix records every mutant', async () => {
        await reach('testing');
        ran.add('testing');
        const room = await learnerGet('testing room', `/phases/${learnerPhases.testing}`);
        const files = Object.fromEntries((room.files as { path: string; content: string }[]).map((one) => [one.path, one.content]));
        const failed = await submit('testing');
        expect(failed.passed).toBe(false);
        expect((failed.report.checks as { id: string; status: string }[]).find((one) => one.id === 'enough-tests')?.status).toBe('failed');
        await readRoom('testing');
        await doorShut('testing');
        sealedGrep('testing fail', 'testing');
        await crossSecond();
        const py = [
          files['tests/test_acceptance.py'],
          '',
          'def test_shelf_order_is_by_title(client, add_book):',
          '    add_book(title="Beloved", author="Toni Morrison", year=1987)',
          '    add_book(title="anansi boys", author="Neil Gaiman", year=2005)',
          '    titles = [book["title"] for book in client.get("/api/books").get_json()]',
          '    assert titles == ["anansi boys", "Beloved"]',
          '',
          'def test_author_filter_ignores_case(client, add_book):',
          '    add_book(title="Kindred", author="Octavia E. Butler", year=1979)',
          '    found = client.get("/api/books?author=octavia e. butler").get_json()',
          '    assert [book["title"] for book in found] == ["Kindred"]',
          '',
          'def test_lend_marks_the_borrower(client, add_book):',
          '    book = add_book()',
          '    lent = client.post(f"/api/books/{book[\'id\']}/lend", json={"borrower": "Ade"})',
          '    assert lent.status_code == 200 and lent.get_json()["on_loan_to"] == "Ade"',
          '',
          'def test_lend_twice_is_refused(client, add_book):',
          '    book = add_book()',
          '    client.post(f"/api/books/{book[\'id\']}/lend", json={"borrower": "Ade"})',
          '    again = client.post(f"/api/books/{book[\'id\']}/lend", json={"borrower": "Bo"})',
          '    assert again.status_code == 409',
          '',
          'def test_return_unknown_is_404(client):',
          '    assert client.post("/api/books/99/return").status_code == 404',
          '',
        ].join('\n');
        const ts = [
          files['web/src/lib/acceptance.test.ts'],
          '',
          "test('a lent book says it is on loan', () => {",
          "  assert.strictEqual(shelfLabel(aBook({ on_loan_to: 'Ade' })), 'Kindred — Octavia E. Butler (1979) · on loan');",
          '});',
          '',
          "test('the shelf order is by title, then id', () => {",
          "  const sorted = sortForShelf([aBook({ id: 2, title: 'b' }), aBook({ id: 1, title: 'B' })]);",
          '  assert.deepStrictEqual(sorted.map((book) => book.id), [1, 2]);',
          '});',
          '',
        ].join('\n');
        await save('testing', { 'tests/test_acceptance.py': py, 'web/src/lib/acceptance.test.ts': ts });
        await run('testing');
        const passed = await submit('testing');
        expectPassed(passed);
        const mutation = passed.report.mutation as { total: number; killed: number; matrix: unknown[] };
        expect({ killed: mutation.killed, total: mutation.total }).toEqual({ killed: 4, total: 4 });
        expect(mutation.matrix).toHaveLength(4);
        await readRoom('testing');
        await doorOpen('testing');
        sealedGrep('testing pass', 'testing');
        await advance('testing');
      }, 180000);
    });

    describe('Deployment', () => {
      it('→ Deployment fails on the unfinished Dockerfile, then the selfcheck passes, the drill pages red and the fix goes green', async () => {
        await reach('deployment');
        ran.add('deployment');
        const room = await learnerGet('deployment room', `/phases/${learnerPhases.deployment}`);
        const files = Object.fromEntries((room.files as { path: string; content: string }[]).map((one) => [one.path, one.content]));
        const failed = await submit('deployment');
        expect(failed.passed).toBe(false);
        expect((failed.report.checks as { id: string; status: string }[]).find((one) => one.id === 'build-smoke')?.status).toBe('failed');
        await readRoom('deployment');
        await doorShut('deployment');
        sealedGrep('deployment fail', 'deployment');
        await crossSecond();
        const dockerfile = files['api/Dockerfile']
          .replace('# TODO(learner): set the directory everything below runs in.', 'WORKDIR /app')
          .replace('# TODO(learner): copy the application into the image (api/ and deploy/).', 'COPY api/ api/\nCOPY deploy/ deploy/')
          .replace('# TODO(learner): start the API, in exec form, so `docker run shelf-api --selfcheck` reaches it.', 'ENTRYPOINT ["python3", "api/main.py"]');
        expect(/TODO\(learner\)/.test(dockerfile)).toBe(false);
        // Shelf's Deployment ships the runbook record (files/runbook.json), whose incident the drill's
        // resolve writes below
        const runbook = serialiseRunbook({
          ...EMPTY_RUNBOOK,
          health: [{ id: 'H1', name: 'Selfcheck', how: 'docker run shelf-api --selfcheck', expected: 'Five routes and config ok.' }],
          rollback: [
            { id: 'R1', step: 'Re-deploy the previous known-good image: docker run shelf-api:previous.', verify: 'The selfcheck prints five routes and config ok.' },
            { id: 'R2', step: 'Put deploy/shelf.json back to the last version that served.', verify: 'The service answers on port 8000.' },
          ],
        });
        await save('deployment', { 'api/Dockerfile': dockerfile, [RUNBOOK_JSON]: runbook });
        // smoke first: the selfcheck through the learner's own ENTRYPOINT
        payloads.length = 0;
        await run('deployment');
        // then the drill: paged against the faulted copy (red), health against the learner's files (green), resolved
        const started = await request(http).post(`/api/v1/phases/${learnerPhases.deployment}/drill/start`).set(bearer(learner.token)).set(from());
        expect({ status: started.status, message: started.status < 300 ? null : started.body?.message }).toEqual({ status: 200, message: null });
        keep('deployment drill start', started);
        expect(started.body.pagedExit).toBe(1);
        const health = await request(http).post(`/api/v1/phases/${learnerPhases.deployment}/drill/health`).set(bearer(learner.token)).set(from()).expect(200);
        keep('deployment drill health', health);
        expect(health.body.exit).toBe(0);
        const resolved = await request(http).post(`/api/v1/phases/${learnerPhases.deployment}/drill/resolve`).set(bearer(learner.token)).set(from())
          .send({ incident: { rootCause: 'deploy/shelf.json set the port to 0.', fix: 'Set the port back to 8000.', actionItem: 'Check the port in review.' } });
        expect({ status: resolved.status, message: resolved.status < 300 ? null : resolved.body?.message }).toEqual({ status: 200, message: null });
        keep('deployment drill resolve', resolved);
        const smokes = payloads.filter((one) => one.mode === 'smoke');
        expect(smokes.length).toBeGreaterThanOrEqual(2);
        const passed = await submit('deployment');
        expectPassed(passed);
        await readRoom('deployment');
        await doorOpen('deployment');
        sealedGrep('deployment pass', 'deployment');
        await advance('deployment');
      }, 180000);
    });

    it('→ Maintenance fails on the unchanged order, then passes with CHG-1 shipped in both layers; the account export carries no sealed byte', async () => {
      await reach('maintenance');
      ran.add('maintenance');
      const room = await learnerGet('maintenance room', `/phases/${learnerPhases.maintenance}`);
      const files = Object.fromEntries((room.files as { path: string; content: string }[]).map((one) => [one.path, one.content]));
      await run('maintenance');
      const failed = await submit('maintenance');
      expect(failed.passed).toBe(false);
      await readRoom('maintenance');
      await doorShut('maintenance');
      sealedGrep('maintenance fail', 'maintenance');
      await crossSecond();
      const py = files['api/shelf.py'];
      const ts = files['web/src/lib/shelf.ts'];
      const donePy = py
        .replace('        # TODO(learner): CHG-1 asks for shelf order by surname, then title, then id.\n', '')
        .replace(
          '        found.sort(key=lambda book: (book["title"].lower(), book["id"]))',
          '        found.sort(key=lambda book: (book["author"].split()[-1].lower(), book["title"].lower(), book["id"]))',
        );
      const doneTs = ts
        .replace(' *\n * TODO(learner): CHG-1 asks for shelf order by surname, then title, then id.\n', '\n')
        .replace(
          '    (a, b) => byText(a.title.toLowerCase(), b.title.toLowerCase()) || a.id - b.id,',
          '    (a, b) =>\n      byText(surname(a), surname(b)) || byText(a.title.toLowerCase(), b.title.toLowerCase()) || a.id - b.id,',
        )
        .concat('\nfunction surname(book: Book): string {\n  const parts = book.author.trim().split(/\\s+/);\n  return parts[parts.length - 1].toLowerCase();\n}\n');
      expect([donePy !== py, doneTs !== ts, /TODO\(learner\)/.test(donePy + doneTs)]).toEqual([true, true, false]);
      // Shelf's older Maintenance converts at the upload door: CHG-1 is its ticket, its objectives AC-1 to AC-3
      const change = serialiseChangeRequest({
        impact: { operations: ['list the shelf'], screens: ['the shelf page'], files: ['api/shelf.py', 'web/src/lib/shelf.ts'] },
        contract: [],
        tests: [{ id: 'T1', suite: 'tests/test_shelf_order.py', covers: ['AC-1', 'AC-3'], result: 'pass' }, { id: 'T2', suite: 'web/src/lib/shelf.test.ts', covers: ['AC-2'], result: 'pass' }],
        release: { version: '1.1.0', summary: 'The shelf is ordered by surname, then title, then id.', changes: [{ id: 'L1', line: 'Shelf order by surname in both layers.', covers: ['AC-1', 'AC-2', 'AC-3'] }], rollback: 'Re-deploy 1.0.0.' },
      });
      finished.maintenance = { 'api/shelf.py': donePy, 'web/src/lib/shelf.ts': doneTs, [CHANGE_REQUEST_JSON]: change };
      await save('maintenance', finished.maintenance);
      await run('maintenance');
      const passed = await submit('maintenance');
      expectPassed(passed);
      await readRoom('maintenance');
      // every other door a learner reads, once the road is walked (none of them may hold a sealed byte)
      for (const url of [
        '/projects', `/projects/${slug}`, `/projects/${slug}/map`, '/enrollments/mine', '/analytics/me',
        `/repo/${slug}/summary`, '/notifications', '/auth/me',
        ...Object.values(learnerPhases).flatMap((id) => [`/phases/${id}/stuck`, `/phases/${id}/lesson/mentor`]),
      ]) {
        await learnerGet(`sweep ${url.replace(/\/phases\/[^/]+/, '/phases/:id')}`, url);
      }
      const repoZip = await request(http).get(`/api/v1/repo/${slug}/export.zip`).set(bearer(learner.token)).set(from()).buffer(true)
        .parse(((res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        }) as never);
      expect(repoZip.status).toBe(200);
      const repoEntries = readZip(repoZip.body as Buffer, zipLimits(config.importMaxBytes));
      expect(repoEntries.length).toBeGreaterThan(0);
      keep('sweep repo export.zip (unzipped)', { text: repoEntries.map((one) => `${one.name}\n${bothWays(one.bytes)}`).join('\n') });
      const exported = await request(http).get('/api/v1/account/export').set(bearer(learner.token)).set(from());
      expect(exported.status).toBe(200);
      keep('account export', exported);
      await doorOpen('maintenance');
      sealedGrep('maintenance pass', 'maintenance');
      // the AI stub was asked: a review per graded submission at least, and the mentor
      expect(aiBodies.some((one) => one.surface === 'chat')).toBe(true);
      expect(aiBodies.filter((one) => one.surface.startsWith('review ')).length).toBeGreaterThanOrEqual(6);
    }, 180000);
  });

  /* ------------------------------ 6. bulk sign-off ------------------------------ */

  describe('6. bulk sign-off', () => {
    it('→ an empty reason is refused; one reason writes one audited row per learner and opens each phase exactly once', async () => {
      // the mark is the product's own: Requirements' task was marked through the editor route before publish (step 4)
      const signers: { id: string; token: string; phases: Record<string, string> }[] = [];
      for (const name of ['journey-signer-1', 'journey-signer-2']) {
        const one = await account(name);
        await request(http).post('/api/v1/enrollments/join').set(bearer(one.token)).set(from()).send({ code: joinCode }).expect(200);
        const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(one.token)).set(from()).send({ projectSlug: slug }).expect(201);
        const phases = Object.fromEntries((enrolled.body.phases as { key: string; id: string }[]).map((p) => [p.key, p.id]));
        await save('requirements', { 'requirements/story.json': SH5_RECORD }, one, phases);
        const verdict = await submit('requirements', one, phases);
        expect(verdict.passed).toBe(true);
        // the countersignature is what the door waits for
        expect(await statusOf('requirements', phases)).not.toBe('passed');
        await learnerGet(`${name} requirements room`, `/phases/${phases.requirements}`, one);
        signers.push({ ...one, phases });
      }
      sealedGrep('signers pass, awaiting sign-off', 'requirements');
      const route = signoffRoute;
      const queue = await queueOf();
      expect(queue.rows.map((one) => one.userId).sort()).toEqual(signers.map((one) => one.id).sort());
      const batch = { phaseKey: 'requirements', taskKey: queue.rows[0].taskKey, userIds: signers.map((one) => one.id).sort() };
      const audited = async () =>
        (await db.manager.find(AuditEventEntity, { where: { subjectUserId: In(signers.map((one) => one.id)) } })).filter((one) => one.event === 'class.bulk-signoff');
      const empty = await request(http).post(route('signoff.bulk')).set(bearer(teacher.token)).set(from()).send({ ...batch, reason: '' });
      expect(empty.status).toBe(400);
      expect(await audited()).toEqual([]);
      const signed = await request(http).post(route('signoff.bulk')).set(bearer(teacher.token)).set(from()).send({ ...batch, reason: 'Heard both stories read aloud in the Tuesday lab.' });
      expect({ status: signed.status, message: signed.status < 300 ? null : signed.body?.message }).toEqual({ status: 200, message: null });
      expect([...(signed.body as BulkSignoffResult).signedOff].sort()).toEqual(batch.userIds);
      const rows = await audited();
      expect(rows.map((one) => one.subjectUserId).sort()).toEqual(batch.userIds);
      const passedAt: Record<string, string | null> = {};
      for (const one of signers) {
        const state = await db.manager.findOneByOrFail(PhaseStateEntity, { id: one.phases.requirements });
        expect(state.status).toBe('passed');
        passedAt[one.id] = state.passedAt;
      }
      // the same batch again opens nothing a second time
      const again = await request(http).post(route('signoff.bulk')).set(bearer(teacher.token)).set(from()).send({ ...batch, reason: 'Heard both stories read aloud in the Tuesday lab.' }).expect(200);
      expect((again.body as BulkSignoffResult).signedOff).toEqual([]);
      expect(await audited()).toHaveLength(2);
      for (const one of signers) {
        expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: one.phases.requirements })).passedAt).toBe(passedAt[one.id]);
        // and the door opens once: Design unlocks on the first Continue, and a second changes nothing
        await request(http).post(`/api/v1/phases/${one.phases.requirements}/advance`).set(bearer(one.token)).set(from()).expect(201);
        const design = await db.manager.findOneByOrFail(PhaseStateEntity, { id: one.phases.design });
        expect(design.status).toBe('in_progress');
        await request(http).post(`/api/v1/phases/${one.phases.requirements}/advance`).set(bearer(one.token)).set(from()).expect(201);
        expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: one.phases.design })).unlockedAt).toBe(design.unlockedAt);
      }
    }, 180000);
  });

  /* ------------------------------ 7. export round trip ------------------------------ */

  describe('7. export round trip', () => {
    const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    };
    const exportOf = (token: string, project: string, version: string) =>
      request(http).get(`/api/v1/instructor/projects/${project}/versions/${version}/export`).set(bearer(token)).set(from()).buffer(true).parse(binary as never);

    it('→ the published version exports, uploads again, and compiles to the same task list', async () => {
      const out = await exportOf(teacher.token, projectId, publishedVersionId);
      expect({ status: out.status, message: out.status === 200 ? null : JSON.parse((out.body as Buffer).toString('utf-8')).message }).toEqual({ status: 200, message: null });
      expect(out.headers['content-type']).toBe('application/zip');
      expect(out.headers['cache-control']).toBe('no-store');
      expect(out.headers['x-export-withheld']).toBe('0');
      const archive = out.body as Buffer;
      expect(readZip(archive, zipLimits(config.importMaxBytes)).length).toBeGreaterThan(0);
      const again = await request(http).post(UPLOAD_PATH).set(bearer(teacher.token)).set(from())
        .send({ title: `Shelf journey again ${stamp}`, archiveBase64: archive.toString('base64') });
      expect({ status: again.status, code: again.body?.code, message: again.status === 201 ? null : again.body?.message }).toEqual({ status: 201, code: undefined, message: null });
      expect(taskListOf(await snapshotOf(again.body.versionId))).toEqual(publishedTaskList);
      // the sign-off mark came back with it: the archive's phase.json task block, then the draft the editor reads
      const marks = (view: { phases: { key: string; tasks: { signOff?: boolean }[] }[] }) => view.phases.map((one) => [one.key, one.tasks.map((task) => task.signOff === true)]);
      expect(marks(await snapshotOf(again.body.versionId))).toEqual(marks(await snapshotOf(publishedVersionId)));
      const requirementsBlock = readZip(archive, zipLimits(config.importMaxBytes)).find((one) => /(^|\/)phases\/[^/]*requirements\/phase\.json$/.test(one.name))!;
      expect(JSON.parse(requirementsBlock.bytes.toString('utf-8')).task).toEqual(expect.objectContaining({ signOff: true }));
      const draftView = await request(http).get(`/api/v1/instructor/projects/${again.body.projectId}/versions/${again.body.versionId}`).set(bearer(teacher.token)).set(from()).expect(200);
      expect(marks(draftView.body)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'].map((key) => [key, [key === 'requirements']]));
      // the teacher's edited suite came back with it
      const back = await snapshotOf(again.body.versionId);
      const implementation = back.content.phases.find((one) => one.key === 'implementation')!;
      expect((implementation.checks as CodeChecks).runs.find((one) => one.hiddenTestFiles[hiddenPath] !== undefined)!.hiddenTestFiles[hiddenPath]).toBe(strongSuite);
      // and every other sealed role too: each phase's compiled grading store (hidden suites, solution,
      // reference tests, impl, mutants, drill) is the published one, byte for byte
      const storesOf = (snapshot: CompiledSnapshot) => JSON.parse(canonicalJson(snapshot.content.phases.map((phase) => ({ key: phase.key, checks: phase.checks }))));
      expect(storesOf(back)).toEqual(storesOf(await snapshotOf(publishedVersionId)));
    }, 120000);

    it('→ a copy of the platform project withholds its inherited sealed files (x-export-withheld > 0)', async () => {
      const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacher.token)).set(from()).expect(200);
      const platform = (library.body.library as { isDefault: boolean; publishedVersionId: string }[]).find((one) => one.isDefault)!;
      const made = await request(http).post('/api/v1/instructor/projects').set(bearer(teacher.token)).set(from())
        .send({ title: `Journey copy ${stamp}`, slug: `journey-copy-${stamp}`, fromVersionId: platform.publishedVersionId });
      expect({ status: made.status, message: made.status === 201 ? null : made.body?.message }).toEqual({ status: 201, message: null });
      const out = await exportOf(teacher.token, made.body.project.id, made.body.draftVersionId);
      expect(out.status).toBe(200);
      expect(Number(out.headers['x-export-withheld'])).toBeGreaterThan(0);
    }, 120000);
  });

  /* ------------------------------ guard ------------------------------ */

  describe('guard: TaskTrackr', () => {
    it('→ TaskTrackr’s own learner path still resolves REFERENCE on every executable phase', async () => {
      const one = await account('journey-tasktrackr-learner');
      const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(one.token)).set(from()).send({}).expect(201);
      const enrolment = await db.manager.findOneByOrFail(EnrollmentEntity, { id: enrolled.body.id });
      expect(enrolment.projectSlug).not.toBe(slug);
      const content = app.get(ContentService);
      const project = content.getForEnrollment(enrolment);
      const executable = project.phases.filter((phase) => ['code', 'tests', 'config'].includes(phase.checks.kind));
      expect(executable.map((phase) => phase.key)).toEqual(['implementation', 'testing', 'deployment', 'maintenance']);
      for (const phase of executable) {
        const tasks = content.getTasksForEnrollment(enrolment, phase.key);
        expect({ key: phase.key, scope: taskScopeOf(phase).kind, task: taskScopeOf(phase, tasks[0], tasks).kind }).toEqual({ key: phase.key, scope: 'reference', task: 'reference' });
      }
    });
  });

  it('records where each step stood: a room was opened by the lever only after a cut step, and every step was grepped twice', () => {
    const order = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
    // the whole journey opens every room by advancing; a reduced form by the lever, from the first step left out on
    const afterACut = order.filter((key) => ran.has(key) && order.slice(0, order.indexOf(key)).some((earlier) => !ran.has(earlier)));
    expect(openedByLever).toEqual(afterACut);
    expect(grepLog.filter((one) => order.some((key) => one.after.startsWith(`${key} `))).length).toBe(2 * ran.size);
    expect(grepLog.every((one) => one.leaks.length === 0 && one.controlFound && one.aiControl.length === 0)).toBe(true);
    // the door was read shut and open for every step that ran, and the accepted rule (a model answer behind it) was exercised
    expect(doorBodies.length).toBe(2 * ran.size);
    expect(grepLog[grepLog.length - 1].doorAllowedSeen).toBeGreaterThan(0);
  });
});
