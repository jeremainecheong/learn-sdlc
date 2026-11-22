// @vitest-environment jsdom
/**
 * The Upload project door on /teacher/projects.
 *
 * An uploaded archive is hostile input until the API has read it, so the door
 * keeps three promises a teacher can see:
 *
 * - **The refusal is the contract's sentence, verbatim.** The page prints
 *   `UPLOAD_REFUSALS[code]` (and `RUN_SHAPE_REFUSALS[code]` per finding) and
 *   never the server's free text, so a sentence can never carry an entry name
 *   or a byte the archive supplied.
 * - **Nothing of the archive is rendered.** Not its bytes, not its file name,
 *   not a `where` that is not a manifest key.
 * - **The size is shown against the cap before anything is sent**, and an
 *   archive over the cap is refused here, by the contract's own sentence,
 *   without a round trip.
 *
 * And the accessibility criteria: the door is a fieldset with a legend,
 * every control has a label, and the file control is described by the size
 * line.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoringLibraryView, RuntimeProfileView } from '@learnsdlc/shared';
import {
  COHORT_IMPORT_MAX_BYTES,
  RUNTIME_PROFILES,
  RUN_SHAPE_REFUSALS,
  SUPPORTED_STACKS_SENTENCE,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_DETAIL_MAX,
  UPLOAD_WHERE_NAMES,
} from '@learnsdlc/shared';

const list = vi.fn();
const create = vi.fn();
const upload = vi.fn();
const runtimeProfile = vi.fn();

vi.mock('@/lib/api-projects', () => ({
  projectsApi: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
    upload: (...args: unknown[]) => upload(...args),
    runtimeProfile: (...args: unknown[]) => runtimeProfile(...args),
  },
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/teacher/projects',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', email: 'teacher-one', name: 'A Teacher', role: 'INSTRUCTOR' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiError } from '@/lib/api';
import { ProjectsLibrary } from '@/components/staff/projects/ProjectsLibrary';
// The where filter and its fixed phrase.
import { WHERE_UNNAMED_KEY, safeWhere } from '@/components/staff/projects/UploadProject';
import { RuntimeProfileLine, runtimeProfileSentence } from '@/components/staff/projects/RuntimeProfileLine';
import { settle, typeInto } from './support/dom';

const EMPTY: AuthoringLibraryView = { mine: [], library: [] };

const PROFILE: RuntimeProfileView = {
  id: 'baked',
  name: 'Baked runtime',
  manifestSha256: 'a'.repeat(64),
  python: ['flask', 'pytest'],
  node: ['react'],
  tools: ['esbuild'],
  sentence: SUPPORTED_STACKS_SENTENCE,
};

/** A marker that must never reach the page, planted in every archive-supplied string. */
const MARKER = 'ARCHIVE-MARKER-7f3a';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  list.mockResolvedValue(EMPTY);
  runtimeProfile.mockResolvedValue(PROFILE);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const byId = (id: string) => host?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function click(id: string) {
  const el = byId(id);
  expect(el, `no control ${id}`).not.toBeNull();
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
}

function type(el: HTMLElement | null, value: string) {
  const node = el as HTMLInputElement;
  typeInto(node, value);
}

async function choose(file: File) {
  const input = byId('projects-upload-file') as HTMLInputElement;
  expect(input, 'no file control').not.toBeNull();
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function openDoor() {
  await act(async () => {
    root?.render(<ProjectsLibrary />);
  });
  await click('projects-upload-open');
}

function archive(bytes = `PK\u0003\u0004 ${MARKER} hidden test body`, name = `${MARKER}-name.zip`): File {
  return new File([bytes], name, { type: 'application/zip' });
}

/** Wait for the promise chain an async click started. */

describe('the Upload project door', () => {
  it('shows the runtime profile line before anything is uploaded', async () => {
    await openDoor();
    await settle(5);
    expect(runtimeProfile).toHaveBeenCalledTimes(1);
    expect(byId('projects-upload-profile')?.textContent).toContain(runtimeProfileSentence(PROFILE));
    expect(runtimeProfileSentence(PROFILE)).toMatch(/^This deployment runs: /);
    expect(upload).not.toHaveBeenCalled();
  });

  it('the size is shown against the cap', async () => {
    await openDoor();
    await choose(archive('x'.repeat(2048)));
    expect(byId('projects-upload-size')?.textContent).toBe('2 KB of the 32 MB upload limit.');
  });

  it('refuses an archive over the cap by the contract sentence, before any request', async () => {
    await openDoor();
    const big = archive('x');
    Object.defineProperty(big, 'size', { value: COHORT_IMPORT_MAX_BYTES + 1 });
    await choose(big);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE);
    expect((byId('projects-upload-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('a refusal sentence is shown verbatim', async () => {
    upload.mockRejectedValue(
      new ApiError(422, 'request failed (422)', undefined, {
        code: 'PATH_CLIMB',
        sentence: UPLOAD_REFUSALS.PATH_CLIMB,
        findings: [],
      }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.PATH_CLIMB);
    expect(push).not.toHaveBeenCalled();
  });

  it('prints each run-shape finding in its own contract sentence', async () => {
    upload.mockRejectedValue(
      new ApiError(422, 'request failed (422)', undefined, {
        code: 'RUN_SHAPE_NOT_ALLOWED',
        sentence: UPLOAD_REFUSALS.RUN_SHAPE_NOT_ALLOWED,
        findings: [
          { code: 'ARGV_SHELL', where: 'checks.smoke.commands[0]', sentence: RUN_SHAPE_REFUSALS.ARGV_SHELL },
        ],
      }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    const refusal = byId('projects-upload-refusal');
    expect(refusal?.querySelector('[data-testid="projects-upload-refusal-sentence"]')?.textContent).toBe(
      UPLOAD_REFUSALS.RUN_SHAPE_NOT_ALLOWED,
    );
    expect(byId('projects-upload-finding-0')?.textContent).toContain(RUN_SHAPE_REFUSALS.ARGV_SHELL);
    expect(byId('projects-upload-finding-0')?.textContent).toContain('checks.smoke.commands[0]');
  });

  it('nothing of the archive is rendered', async () => {
    // The server misbehaves on purpose: its sentence, its message, a finding's
    // sentence and its `where` all carry archive text. None of it may land.
    upload.mockRejectedValue(
      new ApiError(422, `entry ../${MARKER}/x refused`, undefined, {
        code: 'SYMLINK',
        sentence: `${UPLOAD_REFUSALS.SYMLINK} ${MARKER}`,
        findings: [{ code: 'ARGV_SCRIPT', where: `../${MARKER} rm -rf`, sentence: `${MARKER} bad` }],
      }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toContain(UPLOAD_REFUSALS.SYMLINK);
    expect(document.body.innerHTML).not.toContain(MARKER);
    expect(document.body.innerHTML).not.toContain('hidden test body');
  });

  it('reads the refusal where a framework wrapped it in message', async () => {
    upload.mockRejectedValue(
      new ApiError(422, 'request failed (422)', undefined, {
        statusCode: 422,
        message: { code: 'TWO_WORK_TASKS', sentence: UPLOAD_REFUSALS.TWO_WORK_TASKS, findings: [] },
      }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.TWO_WORK_TASKS);
  });

  it('a refusal with no code the contract knows is said without the server text', async () => {
    upload.mockRejectedValue(new ApiError(413, `too big: ${MARKER}`, undefined, { message: `too big: ${MARKER}` }));
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(MARKER);
  });

  it('sends the archive as base64 with the title, and opens the draft on success', async () => {
    upload.mockResolvedValue({
      projectId: 'p-up',
      versionId: 'v-up',
      slug: 'books-on-a-shelf',
      version: '0.1.0',
      compile: { phases: 6, tasks: 6, files: 40, sandboxBudget: 22 },
      validation: null,
    });
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive('PK-bytes'));
    await click('projects-upload-submit');
    await settle(5);
    expect(upload).toHaveBeenCalledTimes(1);
    const [body] = upload.mock.calls[0] as [{ title: string; archiveBase64: string }];
    expect(body.title).toBe('Books on a shelf');
    expect(atob(body.archiveBase64)).toBe('PK-bytes');
    expect(push).toHaveBeenCalledWith('/teacher/projects/p-up/versions/v-up');
  });

  // The door's own refusals beyond the reader print their contract sentence. A
  // NOT_A_PACK that carries the loader's own sentence still prints the fixed
  // one: the page never prints server text.
  it.each([
    ['NOT_A_PACK', `the loader says: ${MARKER}/phase.yaml is bad`],
    ['WARMUP_NOT_UPLOADABLE', UPLOAD_REFUSALS.WARMUP_NOT_UPLOADABLE],
    ['TITLE_INVALID', UPLOAD_REFUSALS.TITLE_INVALID],
    // A guard: this code is mapped through UPLOAD_REFUSALS like every other.
    ['ARCHIVE_NAME_TOO_LONG', `entry ${MARKER}/${'a'.repeat(40)} is too long`],
  ] as const)('prints the contract sentence for %s', async (code, sentence) => {
    upload.mockRejectedValue(
      new ApiError(400, sentence, undefined, { statusCode: 400, message: sentence, code, sentence, findings: [] }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS[code]);
    expect(document.body.innerHTML).not.toContain(MARKER);
  });

  // A title the API would refuse is
  // refused here, by the same contract sentence, before the archive is read.
  it('refuses a title over 120 characters before it sends anything', async () => {
    await openDoor();
    type(byId('projects-upload-title'), 'B'.repeat(121));
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(upload).not.toHaveBeenCalled();
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.TITLE_INVALID);
  });

  // The API's phase-scoped wheres are manifest keys too.
  it('shows where a phase-scoped finding was found, and drops a bracket that is not a phase', async () => {
    upload.mockRejectedValue(
      new ApiError(400, 'x', undefined, {
        code: 'RUN_SHAPE_NOT_ALLOWED',
        sentence: UPLOAD_REFUSALS.RUN_SHAPE_NOT_ALLOWED,
        findings: [
          { code: 'ARGV_SHELL', where: 'phases[implementation].tasks', sentence: RUN_SHAPE_REFUSALS.ARGV_SHELL },
          { code: 'ARGV_SHELL', where: 'phases[#2]', sentence: RUN_SHAPE_REFUSALS.ARGV_SHELL },
          { code: 'ARGV_SHELL', where: `phases[${MARKER}]`, sentence: RUN_SHAPE_REFUSALS.ARGV_SHELL },
        ],
      }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-finding-0')?.textContent).toContain('Found at phases[implementation].tasks.');
    expect(byId('projects-upload-finding-1')?.textContent).toContain('Found at phases[#2].');
    expect(byId('projects-upload-finding-2')?.textContent).not.toContain('Found at');
    expect(document.body.innerHTML).not.toContain(MARKER);
  });

  // A timeout may still end in a draft, so the page
  // does not tell the teacher simply to try again.
  it('says a timed-out upload may still land, and to look for the draft before uploading again', async () => {
    upload.mockRejectedValue(new ApiError(0, 'The server did not answer. Try again in a moment.'));
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    const said = byId('projects-upload-refusal')?.textContent ?? '';
    expect(said).not.toMatch(/try again in a moment/i);
    expect(said).toMatch(/before you upload/i);
  });

  /* ---------- NOT_A_PACK's detail, and the profile's cap ---------- */

  async function refuseWith(body: Record<string, unknown>) {
    upload.mockRejectedValue(new ApiError(400, 'request failed (400)', undefined, { statusCode: 400, error: 'Bad Request', message: 'x', ...body }));
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
  }

  it('a NOT_A_PACK refusal shows the fixed sentence and its detail as plain text', async () => {
    const detail = 'phases/implementation/phase.json: checks.runs[0].testPaths must be a list of paths.';
    await refuseWith({ code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK, findings: [], detail });
    expect(byId('projects-upload-refusal-sentence')?.textContent).toBe(UPLOAD_REFUSALS.NOT_A_PACK);
    const shown = byId('projects-upload-refusal-detail');
    expect(shown?.textContent).toBe(detail);
    // One text node carries it: nothing was built from it.
    expect(shown?.childNodes.length).toBe(1);
    expect(shown?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    // Under the sentence, in the same alert.
    const box = byId('projects-upload-refusal');
    expect(box?.contains(shown as Node)).toBe(true);
    expect(box?.textContent).toBe(`${UPLOAD_REFUSALS.NOT_A_PACK}${detail}`);
  });

  it('a detail holding markup renders as literal text', async () => {
    const detail = '<img src=x onerror="alert(1)"><b>phase.json</b><script>x()</script>';
    await refuseWith({ code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK, findings: [], detail });
    const box = byId('projects-upload-refusal');
    expect(byId('projects-upload-refusal-detail')?.textContent).toBe(detail);
    expect(box?.querySelectorAll('img, b, script, a, iframe').length).toBe(0);
  });

  it('caps the detail at UPLOAD_REFUSAL_DETAIL_MAX characters on the client too', async () => {
    await refuseWith({ code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK, findings: [], detail: 'd'.repeat(UPLOAD_REFUSAL_DETAIL_MAX * 3) });
    expect(byId('projects-upload-refusal-detail')?.textContent).toBe('d'.repeat(UPLOAD_REFUSAL_DETAIL_MAX));
  });

  it('nothing of the archive is rendered: no byte, no file name, and no detail beside another code', async () => {
    await refuseWith({ code: 'SYMLINK', sentence: UPLOAD_REFUSALS.SYMLINK, findings: [], detail: `${MARKER} link` });
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.SYMLINK);
    expect(byId('projects-upload-refusal-detail')).toBeNull();
    expect(document.body.innerHTML).not.toContain(MARKER);
    expect(document.body.innerHTML).not.toContain('hidden test body');
  });

  it('the size shown and the client-side too-large refusal use the profile’s uploadMaxBytes', async () => {
    runtimeProfile.mockResolvedValue({ ...PROFILE, uploadMaxBytes: 1024 * 1024 });
    await openDoor();
    await settle(5);
    expect(byId('projects-upload-size')?.textContent).toBe('No archive chosen yet. The upload limit is 1 MB.');
    await choose(archive('x'.repeat(2048)));
    expect(byId('projects-upload-size')?.textContent).toBe('2 KB of the 1 MB upload limit.');
    // Under the class-import default, over the profile's cap: refused here.
    const big = archive('x');
    Object.defineProperty(big, 'size', { value: 1024 * 1024 + 1 });
    await choose(big);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE);
    expect((byId('projects-upload-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('falls back to the class-import cap when the profile names none', async () => {
    await openDoor();
    await settle(5);
    expect(byId('projects-upload-size')?.textContent).toBe('No archive chosen yet. The upload limit is 32 MB.');
    const big = archive('x');
    Object.defineProperty(big, 'size', { value: COHORT_IMPORT_MAX_BYTES + 1 });
    await choose(big);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE);
  });

  it('asks for a title before it sends anything', async () => {
    await openDoor();
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(upload).not.toHaveBeenCalled();
    expect(byId('projects-upload-refusal')).toBeNull();
    expect(byId('projects-upload-error')?.textContent).toMatch(/^[A-Z]/);
  });

  // The client-side title refusal goes once the title changes.
  it('a client-side title refusal clears when the title is edited', async () => {
    await openDoor();
    type(byId('projects-upload-title'), 'B'.repeat(130));
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.TITLE_INVALID);
    await act(async () => type(byId('projects-upload-title'), 'B'.repeat(40)));
    expect(byId('projects-upload-refusal')).toBeNull();
  });

  it('a refusal the API answered stays while the title is edited', async () => {
    upload.mockRejectedValue(
      new ApiError(400, 'x', undefined, { code: 'RESERVED_NAME', sentence: UPLOAD_REFUSALS.RESERVED_NAME, findings: [] }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.RESERVED_NAME);
    await act(async () => type(byId('projects-upload-title'), 'Books on another shelf'));
    expect(byId('projects-upload-refusal')?.textContent).toBe(UPLOAD_REFUSALS.RESERVED_NAME);
  });

  // A where prints only the shared contract's member
  // names; any other identifier the archive chose is replaced by a fixed phrase.
  it('a where prints no key name the archive chose', async () => {
    upload.mockRejectedValue(
      new ApiError(400, 'x', undefined, {
        code: 'RUN_SHAPE_NOT_ALLOWED',
        sentence: UPLOAD_REFUSALS.RUN_SHAPE_NOT_ALLOWED,
        findings: [
          { code: 'RUN_OWN_COMMAND', where: 'phases[implementation].runs[0].myInternalNote.command', sentence: RUN_SHAPE_REFUSALS.RUN_OWN_COMMAND },
          { code: 'RUN_OWN_COMMAND', where: 'phases[implementation].checks.runs[0].command', sentence: RUN_SHAPE_REFUSALS.RUN_OWN_COMMAND },
          { code: 'ARGV_SHELL', where: 'phases[deployment].checks.smoke.commands[0]', sentence: RUN_SHAPE_REFUSALS.ARGV_SHELL },
          { code: 'LIMIT_TIMEOUT', where: 'project.preview.service.timeoutSeconds', sentence: RUN_SHAPE_REFUSALS.LIMIT_TIMEOUT },
        ],
      }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).not.toContain('myInternalNote');
    expect(byId('projects-upload-finding-0')?.textContent).toContain(
      `Found at phases[implementation].runs[0].${WHERE_UNNAMED_KEY}.command.`,
    );
    expect(byId('projects-upload-finding-1')?.textContent).toContain('Found at phases[implementation].checks.runs[0].command.');
    expect(byId('projects-upload-finding-2')?.textContent).toContain('Found at phases[deployment].checks.smoke.commands[0].');
    expect(byId('projects-upload-finding-3')?.textContent).toContain('Found at project.preview.service.timeoutSeconds.');
  });

  it('safeWhere keeps the contract’s names, replaces any other identifier, and drops what is not a where', () => {
    expect(safeWhere('checks.smoke.commands[0]')).toBe('checks.smoke.commands[0]');
    expect(safeWhere('phases[#2].tasks')).toBe('phases[#2].tasks');
    expect(safeWhere('warmup.check.harness')).toBe('warmup.check.harness');
    expect(safeWhere('project.secretPlan.argv')).toBe(`project.${WHERE_UNNAMED_KEY}.argv`);
    // The API's own fallback for a key it would not print is kept as the same phrase.
    expect(safeWhere('phases[testing].tasks.(a key).run')).toBe(`phases[testing].tasks.${WHERE_UNNAMED_KEY}.run`);
    expect(safeWhere(`../${MARKER}`)).toBeNull();
    expect(safeWhere('phases[evil]')).toBeNull();
  });

  // The keys docs/authoring-format.md documents are layout names, not the archive's own.
  it('safeWhere keeps the keys the authoring format documents', () => {
    for (const where of [
      'phases[implementation].checks.runs[0].timeout',
      'phases[implementation].checks.runs[0].memory',
      'phases[deployment].checks.drill.faultedFiles',
      'phases[implementation].checks.runs[1].hiddenTestDir',
      'phases[testing].checks.runs[0].implFiles',
      'phases[testing].checks.supportFiles',
      'phases[testing].checks.runs[0].learnerTestFiles',
      'phases[deployment].checks.smoke.implFiles',
    ]) {
      expect(safeWhere(where)).toBe(where);
    }
    expect(safeWhere('phases[deployment].checks.drill.myInternalNote')).toBe(
      `phases[deployment].checks.drill.${WHERE_UNNAMED_KEY}`,
    );
  });

  // The API prints a `where` from the same shared set, so the page and the API name the same keys.
  it('safeWhere prints every name in the shared UPLOAD_WHERE_NAMES as itself, and nothing else', () => {
    for (const name of UPLOAD_WHERE_NAMES) expect(safeWhere(`project.${name}`)).toBe(`project.${name}`);
    expect(UPLOAD_WHERE_NAMES.has('notAContractName')).toBe(false);
    expect(safeWhere('project.notAContractName')).toBe(`project.${WHERE_UNNAMED_KEY}`);
  });
});

describe('the Upload project door: labelled form groups', () => {
  it('is a fieldset with a legend, every control labelled, the file control described by the size line', async () => {
    await openDoor();
    const door = byId('projects-upload');
    const fieldset = door?.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.querySelector('legend')?.textContent?.trim()).toBeTruthy();
    for (const control of [...(door?.querySelectorAll('input, select, textarea') ?? [])]) {
      const id = control.getAttribute('id');
      expect(id, 'a control with no id cannot be labelled').toBeTruthy();
      expect(door?.querySelector(`label[for="${id}"]`), `no label for ${id}`).not.toBeNull();
    }
    const file = byId('projects-upload-file') as HTMLInputElement;
    const described = (file.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(described.length).toBeGreaterThan(0);
    const size = byId('projects-upload-size');
    expect(described).toContain(size?.id);
  });

  it('puts focus on the refusal so a keyboard user hears it', async () => {
    upload.mockRejectedValue(
      new ApiError(422, 'x', undefined, { code: 'NOT_A_ZIP', sentence: UPLOAD_REFUSALS.NOT_A_ZIP, findings: [] }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    const refusal = byId('projects-upload-refusal');
    expect(refusal?.getAttribute('role')).toBe('alert');
    // The case asserts the focus it is named for.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 40));
    });
    expect(document.activeElement).toBe(refusal);
  });
});

describe('the runtime profile line', () => {
  it('names the profile and what it runs, from the contract when no read has answered', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const r = createRoot(div);
    act(() => {
      r.render(
        <RuntimeProfileLine
          stacks={{ python: ['flask'], node: ['react'], tools: ['esbuild'], sentence: SUPPORTED_STACKS_SENTENCE }}
          testId="profile"
        />,
      );
    });
    const line = div.querySelector('[data-testid="profile"]');
    expect(line?.textContent).toContain('This deployment runs: ');
    expect(line?.textContent).toContain(RUNTIME_PROFILES[0].name);
    expect(line?.textContent).toContain('flask');
    act(() => r.unmount());
    div.remove();
  });

  // The manifestSha256 wording.
  it('the profile line names the digest as the sha256 of the baked allow-lists', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const r = createRoot(div);
    act(() => {
      r.render(<RuntimeProfileLine profile={PROFILE} testId="profile" />);
    });
    const said = div.querySelector('[data-testid="profile"]')?.textContent ?? '';
    expect(said).toContain('sha256 of the baked allow-lists (python, node, tools)');
    expect(said).toContain(PROFILE.manifestSha256.slice(0, 12));
    expect(said).not.toMatch(/manifest/);
    act(() => r.unmount());
    div.remove();
  });
});

// The upload's audit row is written as action = slug and
// detail { slug, versionId, archiveBytes }; there is no title in it.
describe('the upload row in the record of changes', () => {
  it('names the project by the slug UP writes', async () => {
    const { describeAudit } = await import('@/components/staff/AuditList');
    const said = describeAudit({
      id: 'audit-up',
      event: 'project.uploaded',
      actorUserId: 'teacher-1',
      actorName: 'A Teacher',
      subjectUserId: 'teacher-1',
      subjectName: 'A Teacher',
      targetId: 'p-up',
      action: 'books-on-a-shelf',
      reason: null,
      detail: { slug: 'books-on-a-shelf', versionId: 'v-up', archiveBytes: 2048 },
      createdAt: '2026-10-01T08:00:00.000Z',
    } as Parameters<typeof describeAudit>[0]);
    expect(said.title).toBe('Uploaded the project books-on-a-shelf as a draft');
  });
});

// A 429 from projects.upload (@RateLimit(5, 60)) is the pace of uploads,
// refused before the archive is read, so the sentence says that and never
// blames the archive. Every other code keeps its own sentence.
describe('the upload refused for its pace (429)', () => {
  const PACE =
    'Too many uploads in the last minute, so this one was not read and nothing was imported. Wait a minute, then upload the archive again.';
  // A no-code 4xx/5xx never blames the archive (it must not say "Check that
  // the archive is a project in the authoring layout and upload it again.").
  const BLAME = 'The upload did not finish, and nothing was imported.';

  it('a 429 is the pace sentence, said at the door, with no server text', async () => {
    upload.mockRejectedValue(
      new ApiError(429, `slow down: ${MARKER}`, undefined, { statusCode: 429, message: `slow down: ${MARKER}` }),
    );
    await openDoor();
    type(byId('projects-upload-title'), 'Books on a shelf');
    await choose(archive());
    await click('projects-upload-submit');
    await settle(5);
    expect(byId('projects-upload-refusal')?.textContent).toBe(PACE);
    expect(document.body.innerHTML).not.toContain(MARKER);
    expect(byId('projects-upload-refusal')?.textContent).not.toContain('authoring layout');
  });

  it('every other code answers with its own sentence', async () => {
    const { uploadFailureSentence } = await import('@/components/staff/projects/UploadProject');
    expect(uploadFailureSentence(new ApiError(429, 'x'))).toBe(PACE);
    expect(uploadFailureSentence(new ApiError(413, `too big: ${MARKER}`))).toBe(UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE);
    expect(uploadFailureSentence(new ApiError(0, 'timed out'))).toBe(
      'The server did not answer in time, so the upload may still finish. Reload this page and look for the draft in your projects before you upload the archive again.',
    );
    expect(uploadFailureSentence(new ApiError(401, 'Your session ended. Sign in again.'))).toBe('Your session ended. Sign in again.');
    expect(uploadFailureSentence(new ApiError(403, 'Only a teacher can upload a project.'))).toBe(
      'Only a teacher can upload a project.',
    );
    for (const status of [400, 404, 409, 422, 428, 430, 500, 502, 503]) {
      expect(uploadFailureSentence(new ApiError(status, `server says ${MARKER}`)), String(status)).toBe(BLAME);
    }
    expect(uploadFailureSentence(new Error(`network ${MARKER}`))).toBe(
      'The upload could not be sent, and nothing was imported. Try again in a moment.',
    );
    expect(uploadFailureSentence(new TypeError('Failed to fetch'))).toBe(
      "Can't reach the server. Check your connection and try again.",
    );
  });
});
