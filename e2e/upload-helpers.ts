import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Page, Response } from '@playwright/test';
import { API_CONTRACT_JSON, DEEP_VALIDATION_CHECK_IDS, DESIGN_JSON, EMPTY_DESIGN, serialiseDesign, serialiseStory, type DeepValidationCheckView, type DeepValidationReceipt, type Story } from '@learnsdlc/shared';
import { entriesOf, writeZip, zipDirectory } from '../apps/api/test/fixtures/upload-packs/archive';
import { ALL_SHELF_MARKERS, SHELF_DIR } from '../apps/api/test/fixtures/upload-packs/markers';
import { E2E_PASS } from './pw-fixtures';
import { E2E_SQLITE, REPO_ROOT } from './support/paths';

/**
 * What the teacher-upload browser proof and the accessibility check's upload
 * screens share.
 *
 * Playwright only: nothing under apps/ imports this file. It reads the upload
 * fixtures (the `shelf` fixture project and the archive writer, node-only
 * modules) read-only, and it holds the one test-only seam this proof needs on
 * macOS:
 *
 * - **MACOS-DEEP-RECEIPT.** macOS runs no learner code (the runner refuses
 *   without kernel isolation), so deep validation here answers "the sandbox
 *   could not run part of this check", and publish of an uploaded project
 *   refuses with `deepReceiptRefusal`. After the spec has asserted that
 *   refusal, `writeDeepReceiptSeam` writes a `passed` receipt whose digest is
 *   the built API's own `executableContentDigest` of the draft row into the
 *   disposable e2e sqlite file, so the browser can go on to publish. No runner
 *   setting is changed (RUNNER_ISOLATION and every runner env stay as the
 *   config leaves them). It is for tests only.
 *
 * It touches only `apps/api/.e2e-data/e2e.sqlite`, the file the config's
 * webServer makes fresh for every run, through `better-sqlite3` from
 * node_modules, and prints no row. A task is never marked `signOff` in that
 * file: the mark is the editor's own toggle, or
 * `PATCH …/tasks/:taskKey {signOff:true}` where a fixture has no page.
 */

/* ------------------------------- the archives ------------------------------ */

/** The `shelf` fixture project, as a clean archive built in memory (pack root at the archive root). */
export function shelfArchive(): Buffer {
  return zipDirectory(SHELF_DIR);
}

/**
 * One hostile archive (the hostile set in `hostile.ts` imports the shared
 * package, so the one this proof needs is built here): the shelf fixture with
 * one entry added whose name climbs out of the project folder. Expected code:
 * PATH_CLIMB.
 */
export function hostilePathClimbArchive(): Buffer {
  return writeZip([...entriesOf(SHELF_DIR), { name: '../shelf-escape.txt', data: Buffer.from('outside the project folder\n') }]);
}

/**
 * Three more archive refusals, each the shelf fixture with exactly one thing
 * changed (the same shapes as the hostile set's nul-in-name and
 * declared-size-mismatch, and a name
 * past the 1,024-byte cap), so the page is seen to say each sentence verbatim.
 */
export function shelfRefusalArchives(): { name: string; code: string; sentence: string; build: () => Buffer }[] {
  return [
    {
      name: 'name-too-long',
      code: 'ARCHIVE_NAME_TOO_LONG',
      sentence: ARCHIVE_NAME_TOO_LONG_SENTENCE,
      build: () => writeZip([...entriesOf(SHELF_DIR), { name: `docs/${'n'.repeat(1_100)}.md`, data: Buffer.from('a long name\n') }]),
    },
    {
      name: 'nul-in-name',
      code: 'NUL_IN_NAME',
      sentence: NUL_IN_NAME_SENTENCE,
      build: () => writeZip([...entriesOf(SHELF_DIR), { name: 'docs/notes\u0000.md', data: Buffer.from('a null in the name\n') }]),
    },
    {
      name: 'declared-size-mismatch',
      code: 'ZIP64_OR_SIZE_MISMATCH',
      sentence: ZIP64_OR_SIZE_MISMATCH_SENTENCE,
      build: () =>
        writeZip(entriesOf(SHELF_DIR).map((entry, i) => (i === 0 ? { ...entry, declaredUncompressedSize: entry.data.length + 7 } : entry))),
    },
  ];
}

/* -------------------------------- sentences -------------------------------- */
// Pinned as literals, each with its source, so the page is compared with the
// words the contract fixed and not with whatever the build happens to import.

/** packages/shared/src/upload-contract.ts UPLOAD_REFUSALS.PATH_CLIMB. */
export const PATH_CLIMB_SENTENCE =
  'An entry in this archive climbs out of the project folder or starts at the root of the disk, so nothing was imported.';

/** packages/shared/src/upload-contract.ts UPLOAD_REFUSALS.ARCHIVE_NAME_TOO_LONG. */
export const ARCHIVE_NAME_TOO_LONG_SENTENCE =
  'An entry name in this archive is longer than 1,024 bytes or has more than 64 parts (folders and the file name), so nothing was imported.';
/** packages/shared/src/upload-contract.ts UPLOAD_REFUSALS.ZIP64_OR_SIZE_MISMATCH. */
export const ZIP64_OR_SIZE_MISMATCH_SENTENCE =
  'An entry in this archive declares a size or checksum it does not have, or a large-archive (ZIP64) size or position beyond the upload limit, so nothing was imported.';
/** packages/shared/src/upload-contract.ts UPLOAD_REFUSALS.NUL_IN_NAME. */
export const NUL_IN_NAME_SENTENCE = 'An entry name in this archive holds a control character, such as a null, so nothing was imported.';

/** apps/api/src/authoring/sealed-roles.ts SEALED_REFUSALS.hiddenName. */
export const HIDDEN_NAME_SENTENCE =
  'A hidden test is a test file the runner executes by its name: test_<name>.py in a Python run, or <name>.test.ts or <name>.test.tsx in a TypeScript run. A hidden suite holds no helper files.';

/** apps/api/src/authoring/deep-validation.ts UNAVAILABLE_SENTENCE. */
export const unavailableSentence = (phaseTitle: string): string =>
  `In ${phaseTitle}, the sandbox could not run part of this check, so it proves nothing yet. Start deep validation again in a moment.`;

/**
 * apps/api/src/authoring/validation.ts deepReceiptRefusal, as an UPLOADED project reads it
 * (`{ uploaded: true }`): every spec that reads it uploads its project. A copy of the
 * reference project reads the longer sentence that says its application is not the reference's.
 */
export const deepReceiptRefusal = (phaseTitle: string): string =>
  `${phaseTitle} has no current deep validation. Run deep validation on this draft and publish once it passes.`;

/** apps/web/components/staff/projects/TaskEditor.tsx SIGN_OFF_LABEL. */
export const SIGN_OFF_LABEL = 'Needs your sign-off';
/** apps/web/components/staff/projects/TaskEditor.tsx SIGN_OFF_HELP. */
export const SIGN_OFF_HELP =
  'A learner who passes a task marked “Needs your sign-off” waits in their class’s sign-off queue until you sign it off. Until then the task does not count as passed, so a required one keeps the next phase shut. A mark is saved as soon as you change it and reaches only the versions you publish from now on, because a published version never changes. An export of the version carries it.';
/** apps/web/components/staff/projects/ProjectEditor.tsx the mark's live line. */
export const signOffSaved = (taskTitle: string): string => `${taskTitle} now needs your sign-off.`;
/** apps/web/components/staff/SignoffQueue.tsx SIGNOFF_QUEUE_EMPTY_BODY. */
export const SIGNOFF_QUEUE_EMPTY_BODY =
  'Mark a task as needing your sign-off in the project editor. Learners on a version published with that mark appear here once they pass it.';
/** apps/web/components/staff/SignoffQueue.tsx SIGNOFF_QUEUE_EMPTY_IN_USE_BODY. */
export const SIGNOFF_QUEUE_EMPTY_IN_USE_BODY = 'Learners who pass a task marked for your sign-off appear here.';
/** apps/web/components/staff/projects/ExportButton.tsx savedSentence, withheld 0. */
export const exportSavedSentence = (fileName: string): string =>
  `Saved ${fileName}. It holds your sealed tests and solution, so keep it where only you can read it.`;

/** packages/shared/src/upload-contract.ts deepValidationCostWarning. */
export const costWarning = (microVMs: number): string =>
  `Deep validation boots ${microVMs === 1 ? '1 microVM' : `${microVMs} microVMs`} in the sandbox, one at a time, and asks no AI model. You can run one deep validation at a time.`;

/** apps/api/src/instructor/quiz-results-export.service.ts QUIZ_*_COLUMNS, joined as `file()` joins them. */
export const QUIZ_HEADERS: Record<'learners' | 'attempts' | 'questions' | 'class', string> = {
  learners:
    'email,displayName,class,project,phaseKey,taskKey,attempts used,attempts voided,best score,latest score,passed,first submittedAt,last submittedAt',
  attempts: 'email,displayName,class,project,phaseKey,taskKey,epoch,attempt,status,score,passed,startedAt,submittedAt,packVersion',
  questions: 'email,class,project,taskKey,epoch,attempt,position,questionId,outcome',
  class: 'class,project,taskKey,questionId,times drawn,times right,% right,learners attempted,learners passed',
};

/* --------------------------------- greps ---------------------------------- */

/** The TaskTrackr names a page about the shelf fixture must never show (case-sensitive). */
export const TASKTRACKR_WORDS: readonly string[] = ['TaskTrackr', 'due_date', 'TASK_SELECT', 'CR-2', 'schema.sql', 'web/dist', 'completeTask', 'US-4', 'Dana'];

/** Every sealed marker of the shelf fixture (SHELF_MARKERS). */
export const SHELF_MARKER_VALUES: readonly string[] = ALL_SHELF_MARKERS;

/** Which of `needles` occur in `text`. */
export const found = (text: string, needles: readonly string[]): string[] => needles.filter((one) => text.includes(one));

/** A marker for one sealed write: unique per run, and not secret-shaped. */
export const sealMarker = (): string => `SEAL-MARK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

export const sha256Hex = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

/* ---------------------------------- seams --------------------------------- */

const BUILT_DEEP_VALIDATION = path.resolve(__dirname, '../apps/api/dist/authoring/deep-validation.js');

type Sqlite = {
  prepare(sql: string): { get(...args: unknown[]): any; run(...args: unknown[]): { changes: number } };
  pragma(sql: string): unknown;
  close(): void;
};

function openE2eDb(): Sqlite {
  const Database = require('better-sqlite3') as new (file: string, options?: { fileMustExist?: boolean }) => Sqlite;
  const db = new Database(E2E_SQLITE, { fileMustExist: true });
  db.pragma('busy_timeout = 10000');
  return db;
}

const parsed = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);

/**
 * MACOS-DEEP-RECEIPT (test-only): a `passed` deep receipt on one
 * draft whose digest is the built API's `executableContentDigest` of the row's
 * stored compile. Call it only after the spec asserted the publish refusal,
 * and after a fast validation stored the draft's current compile. Returns the
 * digest it wrote (a content hash, not a secret).
 */
export function writeDeepReceiptSeam(versionId: string): { contentDigest: string; microVMs: number } {
  const { executableContentDigest } = require(BUILT_DEEP_VALIDATION) as {
    executableContentDigest: (version: { compiled: unknown }) => string;
  };
  const db = openE2eDb();
  try {
    const row = db.prepare('SELECT "status", "compiled", "validation" FROM "project_versions" WHERE "id" = ?').get(versionId);
    if (!row) throw new Error('MACOS-DEEP-RECEIPT: no such version row');
    if (row.status !== 'draft') throw new Error('MACOS-DEEP-RECEIPT: the version is not a draft');
    const compiled = parsed(row.compiled);
    if (!compiled?.content) throw new Error('MACOS-DEEP-RECEIPT: the draft has no stored compile');
    const contentDigest = executableContentDigest({ compiled });
    const stored = (parsed(row.validation) ?? {}) as Record<string, any>;
    const prior: DeepValidationReceipt | undefined = stored.deep;
    const now = new Date().toISOString();
    const checks: DeepValidationCheckView[] = DEEP_VALIDATION_CHECK_IDS.map((id) => {
      const was = prior?.checks?.find((one) => one.id === id);
      return {
        id,
        status: 'passed',
        sentence: 'MACOS-DEEP-RECEIPT seam (test only): written by the browser proof on a host that runs no learner code.',
        phaseKey: was?.phaseKey ?? null,
        taskKey: was?.taskKey ?? null,
      };
    });
    const microVMs = typeof prior?.microVMs === 'number' ? prior.microVMs : 0;
    const receipt: DeepValidationReceipt = { contentDigest, status: 'passed', checks, microVMs, startedAt: now, finishedAt: now };
    const { deepRun: _settled, ...rest } = stored;
    const next = JSON.stringify({ ...rest, deep: receipt });
    const wrote = db
      .prepare('UPDATE "project_versions" SET "validation" = ? WHERE "id" = ? AND "status" = \'draft\'')
      .run(next, versionId);
    if (wrote.changes !== 1) throw new Error('MACOS-DEEP-RECEIPT: the receipt was not written');
    return { contentDigest, microVMs };
  } finally {
    db.close();
  }
}

/* --------------------------- evidence hygiene ---------------------------- */
// The journey's evidence hygiene: what a screenshot must hide, every body the
// journey greps saved for an offline re-grep, and the not-a-pack archive and
// the editor sentences the journey checks. Nothing here prints a code, a
// token, an address or an id.

/**
 * Every element that shows a class join code or an invitation code, as a CSS
 * selector Playwright's `mask` takes. `what` says where it is drawn.
 */
export const JOIN_CODE_MASKS: readonly { what: string; selector: string }[] = [
  // the teacher's class page ("Class join code") and the learner's classroom page
  { what: 'class page / classroom join code', selector: 'code.exp-code' },
  // the teacher home's "Your classes" row: "<n> learners, <code>"
  { what: 'teacher home class row', selector: 'a.exp-row[href^="/teacher/class?class="] small' },
  // the receipt a teacher sees right after making a class
  { what: 'created-class receipt', selector: 'section[aria-label="Created class"] code' },
  // the setup page's class code input
  { what: 'onboarding class code input', selector: '#onboarding-class-code' },
  // the classroom page's "Class code" join input
  { what: 'classroom join input', selector: 'label.exp-field:has-text("Class code") input' },
  // the join page's class rows: the copy-the-code button
  { what: 'join page copy-code button', selector: '[data-testid^="cohort-code-"]' },
  // the admin page's class rows ("code <code>, owned by ...")
  { what: 'admin class row', selector: 'li p:has-text(", code ")' },
  // an invitation link a page draws (its address carries the code)
  { what: 'invitation link', selector: 'a[href*="code="]' },
  // the admin page's learner class picker: each option reads "<name>, code <code>, <email>"
  { what: 'admin class picker', selector: 'select:has(option:has-text(", code "))' },
  // the roster import receipt: "The join code is <code>"
  { what: 'roster import join code', selector: '[data-testid="import-result"] span.mono' },
];

/** A join code in the forms a page draws or a learner types it. */
function codeForms(codes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of codes) {
    const code = (raw ?? '').trim();
    if (code.length < 4) continue;
    out.add(code.toUpperCase());
    out.add(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
  }
  return [...out].filter((one) => one.length >= 4);
}

/**
 * A screenshot with every join/invitation code holder masked.
 *
 * Before it captures, it scans the page's visible text and every input's value
 * for `codes` (the run's own codes; required, so a caller states them, and
 * empty only before the run has a class). Each holder it finds must sit inside an
 * element `JOIN_CODE_MASKS` names; one that does not throws, naming only the
 * holder's tag and kind, never the code. A frame that would show a code is
 * therefore never written.
 */
export async function captureMasked(
  page: Page,
  file: string,
  codes: readonly string[],
  options: { fullPage?: boolean } = {},
): Promise<{ file: string; masks: number; holders: number }> {
  const needles = codeForms(codes);
  const fullPage = options.fullPage === true;
  const flag = 'data-code-mask';
  // Each mask's elements are flagged through Playwright's own selector engine (a
  // selector may use :has-text), then the scan asks of every holder whether it
  // sits inside a flagged element. The flags are removed before the capture.
  let masks = 0;
  for (const one of JOIN_CODE_MASKS) {
    masks += await page.locator(one.selector).evaluateAll((els, mark) => {
      els.forEach((el) => el.setAttribute(mark, ''));
      return els.length;
    }, flag);
  }
  let scan: { holders: { kind: string; tag: string; covered: boolean }[] };
  try {
    scan = await page.evaluate(
      ({ needles, fullPage, flag }) => {
        const holders: { kind: string; tag: string; covered: boolean }[] = [];
        const inView = (r: DOMRect) =>
          r.width > 0 && r.height > 0 && (fullPage || (r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth));
        const shows = (el: Element) =>
          typeof (el as any).checkVisibility === 'function'
            ? (el as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            : (el as HTMLElement).offsetParent !== null;
        const holds = (text: string | null | undefined) => {
          const up = (text ?? '').toUpperCase();
          const bare = up.replace(/[^A-Z0-9]/g, '');
          return needles.some((one: string) => up.includes(one) || bare.includes(one));
        };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!parent || !holds(node.nodeValue) || !shows(parent)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (!Array.from(range.getClientRects()).some(inView)) continue;
          holders.push({ kind: 'text', tag: parent.tagName.toLowerCase(), covered: Boolean(parent.closest(`[${flag}]`)) });
        }
        for (const field of Array.from(document.querySelectorAll('input, textarea')) as (HTMLInputElement | HTMLTextAreaElement)[]) {
          if (!holds(field.value) || !shows(field) || !inView(field.getBoundingClientRect())) continue;
          holders.push({ kind: 'value', tag: field.tagName.toLowerCase(), covered: Boolean(field.closest(`[${flag}]`)) });
        }
        // a closed select draws its chosen option's text, whose own rects are empty, so the text walk skips it
        for (const pick of Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]) {
          const shown = Array.from(pick.selectedOptions).map((one) => one.text).join(' ');
          if (!holds(shown) || !shows(pick) || !inView(pick.getBoundingClientRect())) continue;
          holders.push({ kind: 'select', tag: 'select', covered: Boolean(pick.closest(`[${flag}]`)) });
        }
        return { holders };
      },
      { needles, fullPage, flag },
    );
  } finally {
    await page.evaluate((mark) => document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark)), flag).catch(() => undefined);
  }
  const bare = scan.holders.filter((one) => !one.covered);
  if (bare.length > 0) {
    throw new Error(
      `captureMasked: ${bare.length} visible holder(s) of the run's code are not masked (${bare
        .map((one) => `${one.kind} in <${one.tag}>`)
        .join(', ')}); no frame was written for ${path.basename(file)}`,
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await page.screenshot({
    path: file,
    fullPage,
    mask: JOIN_CODE_MASKS.map((one) => page.locator(one.selector)),
    maskColor: '#444444',
  });
  fs.chmodSync(file, 0o600);
  return { file, masks, holders: scan.holders.length };
}

/* --- the not-a-pack refusal and the editor's file sentences --- */

/** An archive that is not a pack at all (a zip with no project.json at its root). Expected code: NOT_A_PACK. */
export function notAPackArchive(): Buffer {
  return writeZip([
    { name: 'docs/README.md', data: Buffer.from('# Notes\n\nA folder of notes, not a project.\n') },
    { name: 'docs/plan.txt', data: Buffer.from('nothing here is a project\n') },
  ]);
}

/** packages/shared/src/upload-contract.ts UPLOAD_REFUSALS.NOT_A_PACK. */
export const NOT_A_PACK_SENTENCE = 'This archive is not a project in the authoring format, so nothing was imported.';

/** apps/web/components/staff/projects/ProjectFiles.tsx SOLUTION_MOUNT_SENTENCE. */
export const SOLUTION_MOUNT_SENTENCE =
  'Your reference solution may also appear as a locked file a learner reads, such as the finished code a later phase builds on; it is never a file a learner is asked to edit.';
/** apps/web/components/staff/projects/ProjectFiles.tsx APP_PREVIEW_NOT_OFFERED_SENTENCE (an uploaded project gets the page preview instead). */
export const APP_PREVIEW_NOT_OFFERED_SENTENCE =
  'In this release, App preview is not offered for an uploaded application or any other application of your own. Learners get the page preview instead: their page code runs in the browser with sample data, and their API does not run there.';

/* --- every body the journey greps, saved for an offline re-grep --- */

/**
 * Where the bodies go: E2E_JOURNEY_BODIES_DIR when set, else `test-results/journey-bodies/` under the repository, the folder
 * `node e2e/journey-regrep.mjs` reads by default. git ignores test-results/.
 */
export function journeyBodiesRoot(): string {
  const fromEnv = process.env.E2E_JOURNEY_BODIES_DIR;
  return fromEnv ? path.resolve(fromEnv) : path.join(REPO_ROOT, 'test-results', 'journey-bodies');
}

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/;
const BEARER_SHAPE = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i;
const ORIGIN_SHAPE = /\b(?:https?|wss?):\/\/[^\s"'<>()\\/]+/gi;
const HOST_SHAPE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|sg|edu|cloud|app|ai|amazonaws)\b/gi;
/** API paths whose bodies are session material (never saved, each exclusion recorded). */
const SESSION_PATHS = /\/api\/v1\/(?:auth|sessions?|session|oauth|google|login|logout|register|token|account)(?:\/|$|\?)/i;

/** The needle sets the journey greps with, by the name the manifest records. */
export type GrepName = 'TASKTRACKR_WORDS' | 'SHELF_MARKER_VALUES' | 'SEAL_MARKER';

export interface SavedBodyEntry {
  path: string;
  sha256: string;
  bytes: number;
  source: 'page-innerText' | 'page-html' | 'response' | 'download';
  label: string;
  learnerFacing: boolean;
  /** Which greps the journey ran on this body, and how many needles each found live. */
  grep: GrepName[];
  liveHits: Partial<Record<GrepName, number>>;
  /** Shapes replaced before the bytes were written (counts only; none can hold a needle). */
  redactions: { id: number; email: number; host: number };
}

/**
 * The bodies the journey greps, saved under `<root>/<epoch>/` (folders 0700,
 * files 0600) with `manifest.json` (path, sha256, bytes, which grep), so
 * `node e2e/journey-regrep.mjs` can re-run every grep offline.
 *
 * Before a body is written, ids, email addresses and host names are replaced
 * by `<id>`, `<email>` and `<host>`; none of the grepped needles holds one, so
 * no grep's answer can change. A body that carries the run's join code or a
 * token, and every session/auth endpoint, is not saved: the exclusion is
 * recorded with the live grep counts instead.
 */
export class JourneyBodies {
  readonly epoch: string;
  readonly dir: string;
  private readonly entries: SavedBodyEntry[] = [];
  private readonly exclusions: { label: string; source: string; reason: string; bytes: number; liveHits: Partial<Record<GrepName, number>> }[] = [];
  private readonly frames: { path: string; sha256: string; bytes: number }[] = [];
  private readonly pending: Promise<void>[] = [];
  private count = 0;
  private codes: string[] = [];
  private sealMarker = '';
  private readonly responsesSeen = { saved: 0, excluded: 0, skippedNoBody: 0 };

  constructor(root: string, epoch = String(Date.now())) {
    this.epoch = epoch;
    this.dir = path.join(root, epoch);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  /** The run's join codes: a body carrying one is excluded, never saved. */
  setCodes(codes: readonly string[]): void {
    this.codes = codeForms(codes);
  }

  setSealMarker(marker: string): void {
    this.sealMarker = marker;
  }

  needles(name: GrepName): readonly string[] {
    if (name === 'TASKTRACKR_WORDS') return TASKTRACKR_WORDS;
    if (name === 'SHELF_MARKER_VALUES') return SHELF_MARKER_VALUES;
    return this.sealMarker ? [this.sealMarker] : [];
  }

  private carriesSecret(text: string): string | null {
    if (JWT_SHAPE.test(text) || BEARER_SHAPE.test(text)) return 'carries a token shape';
    const up = text.toUpperCase();
    if (this.codes.some((one) => up.includes(one))) return "carries the run's join code";
    return null;
  }

  private redact(text: string): { text: string; redactions: SavedBodyEntry['redactions'] } {
    const redactions = { id: 0, email: 0, host: 0 };
    let out = text.replace(UUID_SHAPE, () => (redactions.id++, '<id>'));
    out = out.replace(EMAIL_SHAPE, () => (redactions.email++, '<email>'));
    out = out.replace(ORIGIN_SHAPE, (m) => (redactions.host++, `${m.split('://')[0]}://<host>`));
    out = out.replace(HOST_SHAPE, () => (redactions.host++, '<host>'));
    return { text: out, redactions };
  }

  private slug(label: string): string {
    return label.replace(UUID_SHAPE, 'id').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'body';
  }

  /**
   * Save one grepped body. `greps` names the sets the journey ran on it; their
   * live counts are recorded beside the saved bytes. Returns the live counts.
   */
  save(
    label: string,
    source: SavedBodyEntry['source'],
    text: string,
    greps: readonly GrepName[],
    learnerFacing: boolean,
  ): Partial<Record<GrepName, number>> {
    const liveHits: Partial<Record<GrepName, number>> = {};
    for (const name of greps) liveHits[name] = found(text, this.needles(name)).length;
    const secret = this.carriesSecret(text);
    if (secret) {
      this.exclusions.push({ label: label.replace(UUID_SHAPE, ':id'), source, reason: secret, bytes: Buffer.byteLength(text), liveHits });
      return liveHits;
    }
    const { text: clean, redactions } = this.redact(text);
    const ext = source === 'page-html' ? 'html' : source === 'response' ? 'txt' : source === 'download' ? 'csv' : 'txt';
    const name = `${String(++this.count).padStart(4, '0')}-${source}-${this.slug(label)}.${ext}`;
    const file = path.join(this.dir, name);
    const bytes = Buffer.from(clean, 'utf8');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    this.entries.push({
      path: name,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      source,
      label: label.replace(UUID_SHAPE, ':id'),
      learnerFacing,
      grep: [...greps],
      liveHits,
      redactions,
    });
    return liveHits;
  }

  /**
   * Save every text/JSON response the page receives from the API origin (the
   * learner's own calls), grepped for the sealed markers and the TaskTrackr
   * words. Session/auth endpoints are excluded by path.
   */
  watchResponses(page: Page, who: string, apiOrigin: string): void {
    page.on('response', (res: Response) => {
      let url: URL;
      try {
        url = new URL(res.url());
      } catch {
        return;
      }
      if (url.origin !== new URL(apiOrigin).origin) return;
      if (res.request().method() === 'OPTIONS') return;
      const label = `${who} ${res.request().method()} ${res.status()} ${url.pathname}`;
      if (SESSION_PATHS.test(url.pathname)) {
        this.exclusions.push({ label: label.replace(UUID_SHAPE, ':id'), source: 'response', reason: 'session/auth endpoint', bytes: 0, liveHits: {} });
        this.responsesSeen.excluded++;
        return;
      }
      const type = (res.headers()['content-type'] ?? '').toLowerCase();
      if (!/json|text\//.test(type)) return;
      this.pending.push(
        res
          .text()
          .then((body) => {
            if (!body) {
              this.responsesSeen.skippedNoBody++;
              return;
            }
            const before = this.exclusions.length;
            this.save(label, 'response', body, ['SHELF_MARKER_VALUES', 'SEAL_MARKER', 'TASKTRACKR_WORDS'], true);
            if (this.exclusions.length > before) this.responsesSeen.excluded++;
            else this.responsesSeen.saved++;
          })
          .catch(() => {
            this.responsesSeen.skippedNoBody++;
          }),
      );
    });
  }

  /** A path for a masked frame of this epoch (`frames/`, 0700). */
  framePath(name: string): string {
    const dir = path.join(this.dir, 'frames');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${this.slug(name)}.png`);
  }

  recordFrame(file: string): void {
    const bytes = fs.readFileSync(file);
    this.frames.push({ path: path.relative(this.dir, file), sha256: sha256Hex(bytes), bytes: bytes.length });
  }

  /** Learner responses saved so far that hold a sealed marker (the journey asserts 0). */
  async responseMarkerHits(): Promise<{ label: string; hits: number }[]> {
    await Promise.all(this.pending);
    return [...this.entries, ...this.exclusions]
      .filter((one) => one.source === 'response')
      .map((one) => ({ label: one.label, hits: (one.liveHits.SHELF_MARKER_VALUES ?? 0) + (one.liveHits.SEAL_MARKER ?? 0) }))
      .filter((one) => one.hits > 0);
  }

  /** Wait for every response body, then write manifest.json (0600). */
  async finish(extra: Record<string, unknown> = {}): Promise<string> {
    await Promise.all(this.pending);
    const manifest = {
      manifest: 'journey-bodies',
      epoch: this.epoch,
      writtenAt: new Date().toISOString(),
      needles: {
        TASKTRACKR_WORDS: [...TASKTRACKR_WORDS],
        SHELF_MARKER_VALUES: [...SHELF_MARKER_VALUES],
        SEAL_MARKER: this.sealMarker ? [this.sealMarker] : [],
      },
      redactionRule:
        'ids -> <id>, email addresses -> <email>, origins and host names -> <host> before writing; no grepped needle holds one of these shapes, so no grep answer changes. A body carrying the join code or a token, and every session/auth endpoint, is excluded and listed with its live counts.',
      responses: this.responsesSeen,
      entries: this.entries,
      exclusions: this.exclusions,
      frames: this.frames,
      ...extra,
    };
    const file = path.join(this.dir, 'manifest.json');
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  }
}

/* --- the learner's chip on a passed task that waits on the teacher --- */

/** apps/web/components/workspace/signoff-status.ts AWAITING_SIGN_OFF; the feedback page's hero draws it as a sentence (with a full stop). */
export const SIGNOFF_CHIP = "Awaiting your teacher's sign-off";

/**
 * apps/web/components/workspace/signoff-status.ts SIGN_OFF_PASS_LINE: the room's feedback Pass line while awaiting,
 * on a one-task phase and on a split phase whose other required tasks have all passed or wait too (the state
 * teacher-upload.spec.ts step 9 reaches on Design).
 */
export const SIGNOFF_PASS_LINE = "Your work passed review. Your teacher's countersignature opens the next phase.";
/** apps/web/components/workspace/signoff-status.ts SIGN_OFF_SUBMIT_REASON (why Submit for review is off while awaiting). */
export const SIGNOFF_SUBMIT_REASON = "Your work passed review and is waiting for your teacher's sign-off, so there is nothing to resubmit.";
/** apps/web/app/(app)/feedback/page.tsx: the review page's line for a passed phase that waits on no one. */
export const PHASE_PASSED_LINE =
  'This phase passed its evidence review. Keep the decisions and their supporting artefacts together as you move forward.';
/**
 * apps/web/components/workspace/FeedbackPanel.tsx passedLine, the signing arm on a split phase with one other
 * required task still open, i.e. not passed and not waiting. teacher-upload.spec.ts step 9 hands in both
 * marked Design tasks (the design and the countersigned task), so both pass and wait, and it asserts this
 * line is NOT drawn.
 */
export const signOffSplitLine = (openTask: string): string =>
  `This task passed review and waits for your teacher's countersignature. One required task in this phase is still open: ${openTask}. The next phase opens once it passes and your teacher has countersigned.`;

/* --- the shelf's own story, as the learner's room writes it --- */

/**
 * SH-5, the story the shelf fixture's learner writes (its phase.json
 * `checks.learnerStory.id`), as the record `requirements/story.json` alone:
 * a full sentence, a happy path and a boundary, and one out-of-scope line,
 * so it meets the shelf's floor. `marked` puts the stub's pass mark
 * (E2E-PASS, e2e/ai-stub.cjs) in the notes, where nothing grades by shape;
 * without it the stub sends the story back.
 */
export function shelfStoryRecord(marked: boolean): string {
  const story: Story = {
    id: 'SH-5',
    title: 'See which books by an author are free to borrow',
    persona: 'member',
    capability: "to see which of an author's books are free to borrow right now",
    benefit: 'I can plan my visit without a wasted trip',
    criteria: [
      { id: 'AC-1', tag: 'happy', given: 'an author with two books on the shelf', when: 'I filter the shelf by that author', then: 'I see both books marked free to borrow' },
      { id: 'AC-2', tag: 'boundary', given: 'a book that is already on loan', when: 'I filter the shelf by its author', then: 'that book shows as on loan and cannot be borrowed' },
    ],
    scopeExclusions: ['holding a book for a member while it is lent out'],
    notes: `Heard from the head librarian at the lending desk.${marked ? ` ${E2E_PASS}` : ''}`,
  };
  return serialiseStory(story);
}

/* --- the shelf's own design, for a sign-off fixture on its Design phase --- */

/**
 * The shelf's Design work as the room's forms write it: the record
 * (`design/design.json`) and the API contract (`shared/contract/api.json`),
 * which meet the shelf's floor (one entity, three operations each with its
 * inputs, a return and its story, one decision with a rationale and a
 * trade-off, four endpoints and an error catalogue), as
 * apps/api/test/teacher-upload-journey.e2e-spec.ts passes it. `marked` puts
 * the stub's pass mark (E2E-PASS, e2e/ai-stub.cjs) in the record's notes;
 * without it the stub sends the design back.
 */
export function shelfDesignWork(marked: boolean): Record<string, string> {
  const record = serialiseDesign({
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
    notes: `The shelf is one entity and three operations, one per story.${marked ? ` ${E2E_PASS}` : ''}`,
  });
  const contract = `${JSON.stringify({
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
  return { [DESIGN_JSON]: record, [API_CONTRACT_JSON]: contract };
}
