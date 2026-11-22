import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { languageOfPath } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { DirectoryPackSource } from '../content/pack-source';
import { compilePack } from '../content/pack-compiler';
import { countTestMethods, stripCodeComments } from '../feedback/checkers';

/**
 * The starter pack's bytes, held to four properties.
 *
 * Each is a property of the pack's bytes, so it reaches a project uploaded
 * from the starter; a project already uploaded keeps the pack it was
 * uploaded with.
 *
 * - `add()`: in all nine copies of the shelf's `shelf.py`, the reference
 *   solutions included, it stays within the analyser's complexity limit of 8.
 *   The year check lives in `_year_is_valid`, and every seal marker stays.
 * - The preview's books: the starter ships `preview/sample-data.json` (four
 *   books, one on loan), locked in the Implementation and Maintenance rooms,
 *   so the page preview does not read "The shelf is empty.".
 * - The Design brief: the Design is a design phase, filled in the Design
 *   room's forms, so the brief, the notes and the mentor ask for no file.
 *   The checks, rubric and files are the shelf's, unchanged.
 * - The test counter: `declare function test(...)` in the Testing room's
 *   suite is not counted as a test, so a suite of nine reads as nine.
 */

const API_DIR = path.resolve(__dirname, '..', '..');
const PACKS = path.join(API_DIR, 'test', 'fixtures', 'upload-packs');
const STARTER = path.join(PACKS, 'starter');
const SHELF = path.join(PACKS, 'shelf');
const ANALYZER = path.join(API_DIR, 'runner', 'analyzer.py');

const read = (rel: string, root = STARTER): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const phaseJson = (dir: string, root = STARTER) => JSON.parse(read(`phases/${dir}/phase.json`, root));

beforeAll(() => Logger.overrideLogger(false));

/* ---------------------------------- add() ---------------------------------- */

/**
 * The nine texts of `shelf.py` the starter holds. In the folder layout a mount
 * is a file in each phase that mounts it: the shelf's own application copy
 * (once `canonical/api/shelf.py`) is Deployment's locked mount, and its smoke
 * run's copy under `smoke/` is the same bytes (checked below); Testing's
 * locked copy sits under its `readonly/`.
 */
const NINE = [
  'phases/05-deployment/readonly/api/shelf.py',
  'phases/03-implementation/files/api/shelf.py',
  'phases/03-implementation/solution/api/shelf.py',
  'phases/04-testing/readonly/api/shelf.py',
  'phases/04-testing/impl/api/shelf.py',
  'phases/04-testing/mutants/author_filter_case_sensitive/api/shelf.py',
  'phases/04-testing/mutants/lend_twice_allowed/api/shelf.py',
  'phases/06-maintenance/files/api/shelf.py',
  'phases/06-maintenance/solution/api/shelf.py',
] as const;

/** The seal marker line each sealed copy carries, byte for byte. */
const MARKERS: Record<string, string> = {
  'phases/03-implementation/solution/api/shelf.py':
    "# seal marker: SHELF-SEALED-SOLUTION-8M2Q (the implementation phase's reference answer)",
  'phases/04-testing/impl/api/shelf.py': '# seal marker: SHELF-SEALED-IMPL-9B6D (the implementation the reference suite is graded against)',
  'phases/04-testing/mutants/author_filter_case_sensitive/api/shelf.py':
    '# seal marker: SHELF-SEALED-MUTANT-2R8N (a planted bug the reference suite must kill)',
  'phases/04-testing/mutants/lend_twice_allowed/api/shelf.py':
    '# seal marker: SHELF-SEALED-MUTANT-2R8N (a planted bug the reference suite must kill)',
  'phases/06-maintenance/solution/api/shelf.py': "# seal marker: SHELF-SEALED-SOLUTION-8M2Q (the change request's reference answer)",
};

const HELPER = [
  'def _year_is_valid(year):',
  '    """A year is optional; when one is given it is a four-digit whole number."""',
  '    if year is None:',
  '        return True',
  '    if isinstance(year, bool) or not isinstance(year, int):',
  '        return False',
  '    return 1000 <= year <= 2999',
].join('\n');

const INLINE = 'if year is not None and (isinstance(year, bool) or not isinstance(year, int) or not 1000 <= year <= 2999):';

/** The analyser the grader runs, over one file, as `SandboxService.analyze` calls it. */
function analyse(rel: string): { issues: { message: string }[]; metrics: { maxComplexity: number } } {
  const out = spawnSync(config.pythonBin, ['-I', '-B', ANALYZER], {
    input: JSON.stringify({ files: { [rel]: read(rel) }, targets: [rel], language: 'python' }),
    encoding: 'utf-8',
  });
  if (out.status !== 0) throw new Error(`analyzer exited ${out.status}: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

/** The lines one text has and the other does not, in order: a diff without positions. */
function delta(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split('\n');
  const y = b.split('\n');
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(x[i++]);
    else added.push(y[j++]);
  }
  removed.push(...x.slice(i));
  added.push(...y.slice(j));
  return { removed, added };
}

describe('add() is within the analyser limit in all nine starter copies', () => {
  it.each(NINE)('%s: the year check is _year_is_valid, and add() calls it', (rel) => {
    const text = read(rel);
    expect(text).toContain(`\n\n${HELPER}\n\n\nclass Shelf:\n`);
    expect(text).toContain('        if not _year_is_valid(year):\n            raise ValueError("year must be a four-digit number")\n');
    expect(text).not.toContain(INLINE);
  });

  it.each(NINE)('%s: the analyser reports no function over the complexity limit', (rel) => {
    const report = analyse(rel);
    expect(report.issues.filter((issue) => /complexity/.test(issue.message))).toEqual([]);
    expect(report.metrics.maxComplexity).toBeLessThanOrEqual(8);
  });

  it('keeps every seal marker line, and only the sealed copies carry one', () => {
    // the smoke run's copy is Deployment's mount byte for byte, so the nine texts are every copy the starter holds
    expect(read('phases/05-deployment/smoke/api/shelf.py')).toBe(read('phases/05-deployment/readonly/api/shelf.py'));
    const walk = (dir: string): string[] => fs.readdirSync(path.join(STARTER, dir), { withFileTypes: true })
      .flatMap((one) => (one.isDirectory() ? walk(`${dir}/${one.name}`) : [`${dir}/${one.name}`]));
    expect(walk('phases').filter((rel) => rel.endsWith('/api/shelf.py')).sort()).toEqual([...NINE, 'phases/05-deployment/smoke/api/shelf.py'].sort());
    for (const rel of NINE) {
      const markers = read(rel)
        .split('\n')
        .filter((line) => line.includes('seal marker:'));
      expect([rel, markers]).toEqual([rel, MARKERS[rel] ? [MARKERS[rel]] : []]);
    }
  });

  it('plants the same two bugs: each mutant differs from impl by its marker and its bug, nothing else', () => {
    const impl = read('phases/04-testing/impl/api/shelf.py');
    const IMPL_MARKER = MARKERS['phases/04-testing/impl/api/shelf.py'];
    const MUTANT_MARKER = MARKERS['phases/04-testing/mutants/lend_twice_allowed/api/shelf.py'];
    expect(delta(impl, read('phases/04-testing/mutants/author_filter_case_sensitive/api/shelf.py'))).toEqual({
      removed: [IMPL_MARKER, '            wanted = author.strip().lower()', '            found = [book for book in found if book["author"].lower() == wanted]'],
      added: [MUTANT_MARKER, '            wanted = author.strip()', '            found = [book for book in found if book["author"] == wanted]'],
    });
    expect(delta(impl, read('phases/04-testing/mutants/lend_twice_allowed/api/shelf.py'))).toEqual({
      removed: [IMPL_MARKER, '        if book["on_loan_to"] is not None:', '            raise ValueError("that book is already on loan")'],
      added: [MUTANT_MARKER],
    });
  });

  it('leaves the web shelf.ts files as the shelf pack has them', () => {
    // every web shelf.ts the starter's phases hold (no canonical/ copy in the folder layout)
    for (const rel of [
      'phases/03-implementation/files/web/src/lib/shelf.ts',
      'phases/03-implementation/solution/web/src/lib/shelf.ts',
      'phases/04-testing/readonly/web/src/lib/shelf.ts',
      'phases/04-testing/impl/web/src/lib/shelf.ts',
      'phases/06-maintenance/files/web/src/lib/shelf.ts',
      'phases/06-maintenance/solution/web/src/lib/shelf.ts',
    ]) {
      expect([rel, read(rel)]).toEqual([rel, read(rel, SHELF)]);
    }
  });
});

/* ---------------------------- the preview's books ---------------------------- */

const SAMPLE = 'preview/sample-data.json';
const SAMPLE_SOURCE = 'phases/03-implementation/readonly/preview/sample-data.json';

describe('the starter ships sample books for the page preview', () => {
  it('holds four books in the Book shape of canonical shelf.ts, one of them on loan', () => {
    // (the shelf's own shelf.ts is Testing's locked copy in the folder layout, which has no canonical/)
    const sample = JSON.parse(read(SAMPLE_SOURCE)) as Record<string, unknown>;
    expect(Object.keys(sample)).toEqual(['/api/books']);
    const books = sample['/api/books'] as Record<string, unknown>[];
    expect(books).toHaveLength(4);
    for (const book of books) {
      expect(Object.keys(book)).toEqual(['id', 'title', 'author', 'year', 'on_loan_to']);
      expect(typeof book.id).toBe('number');
      expect(typeof book.title).toBe('string');
      expect(typeof book.author).toBe('string');
      expect(book.year === null || (Number.isInteger(book.year) && (book.year as number) >= 1000 && (book.year as number) <= 2999)).toBe(true);
      expect(book.on_loan_to === null || typeof book.on_loan_to === 'string').toBe(true);
    }
    expect(new Set(books.map((book) => book.id)).size).toBe(4);
    expect(books.filter((book) => book.on_loan_to !== null)).toHaveLength(1);
    // the interface the page reads: the same five fields, in the same order
    const shape = /export interface Book \{([^}]*)\}/.exec(read('phases/04-testing/readonly/web/src/lib/shelf.ts'))?.[1] ?? '';
    expect([...shape.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])).toEqual(['id', 'title', 'author', 'year', 'on_loan_to']);
  });

  it.each(['03-implementation', '06-maintenance'])('%s declares it as a locked json file', (dir) => {
    // the folder layout declares a mount by where it sits: locked under readonly/, its language json by its path
    expect('files' in phaseJson(dir)).toBe(false);
    expect(fs.existsSync(path.join(STARTER, `phases/${dir}/files/${SAMPLE}`))).toBe(false);
    expect(read(`phases/${dir}/readonly/${SAMPLE}`)).toBe(read(SAMPLE_SOURCE));
    expect(languageOfPath(SAMPLE)).toBe('json');
  });

  it('is loaded into both rooms as a visible file, and is no check target, solution or graded path', () => {
    const loaded = new ContentService().loadProject(new DirectoryPackSource(STARTER));
    const want = read(SAMPLE_SOURCE);
    for (const key of ['implementation', 'maintenance']) {
      const phase = loaded.phases.find((one) => one.key === key)!;
      expect(phase.files.filter((file) => file.path === SAMPLE)).toEqual([{ path: SAMPLE, content: want, editable: false, language: 'json' }]);
      expect(JSON.stringify(phase.checks)).not.toContain(SAMPLE);
    }
    const compiled = compilePack({ ...loaded, slug: 'starter-check', title: 'Starter check', version: '0.1.0' });
    expect(compiled.sandboxBudget).toBe(16);
  });
});

/* ------------------------------ the Design brief ------------------------------ */

describe('the Design brief is written for the Design room\'s forms', () => {
  const design = () => phaseJson('02-design');

  it('keeps the checks, rubric, files and objectives of the shelf pack, byte for byte, and they are a design phase', () => {
    const shelf = phaseJson('02-design', SHELF);
    expect(design().checks).toEqual(shelf.checks);
    expect(design().rubric).toEqual(shelf.rubric);
    expect(design().files).toEqual(shelf.files);
    expect(design().objectives).toEqual(shelf.objectives);
    expect(design().artifactKind).toBe('design');
    expect(design().checks.kind).toBe('design');
    expect(design().checks.contracts).toEqual({ api: true, screens: false });
    expect(design().checks.sequence).toBe(false);
    // the folder layout names no file in phase.json, and the Design mounts none
    expect('files' in design()).toBe(false);
    expect(design().taskFile).toBeUndefined();
    expect(fs.existsSync(path.join(STARTER, 'phases/02-design/task.md'))).toBe(false);
    expect(fs.existsSync(path.join(STARTER, 'phases/02-design/files'))).toBe(false);
  });

  it('says where the design is filled, in the brief and the notes, and names no markdown file', () => {
    const brief = (design().taskPanel as string).replace(/\s+/g, ' ');
    const notes = read('phases/02-design/NOTES.md').replace(/\s+/g, ' ');
    expect(brief).toContain("Fill the design in the Design room's forms");
    expect(notes).toMatch(/opens on the Design forms/);
    for (const text of [brief, notes]) {
      expect(text).toMatch(/entit/i);
      expect(text).toMatch(/endpoint/i);
      expect(text).toMatch(/refus/i);
      expect(text).not.toMatch(/my-design\.md|\.md\b/);
      expect(text).not.toContain('\u00b7');
    }
    // the notes say why the sequence diagram is off, and what switching it on adds
    expect(notes).toMatch(/"sequence": false/);
    expect(notes).toMatch(/Sequence diagram tab/);
    // never the hand-written table the forms replaced
    expect(brief).not.toMatch(/table row per operation/i);
  });

  it("tells the mentor where the learner fills the design, and asks for nothing the review's checks do not", () => {
    const prompt = design().assistant.systemPrompt as string;
    expect(prompt).toContain("The learner fills the design record and the API contract in the Design room's forms.");
    expect(prompt).not.toMatch(/my-design\.md/);
    expect(prompt).toContain('never write the learner\'s answer for them');
  });
});

/* ----------------------------- the test counter ----------------------------- */

const LEARNER_PY = `
def test_author_filter_ignores_case(client, add_book):
    add_book(title="Emma", author="Jane Austen", year=1815)
    assert client.get("/api/books?author=jane austen").status_code == 200


def test_books_come_in_title_order(client, add_book):
    assert client.get("/api/books").status_code == 200


def test_lend_records_the_borrower(client, add_book):
    book = add_book()
    assert client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"}).status_code == 200


def test_a_lent_book_cannot_be_lent_again(client, add_book):
    book = add_book()
    client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})
    assert client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Bo"}).status_code == 409


def test_return_puts_the_book_back(client, add_book):
    book = add_book()
    client.post(f"/api/books/{book['id']}/lend", json={"borrower": "Ade"})
    assert client.post(f"/api/books/{book['id']}/return").status_code == 200


def test_returning_an_unknown_book_is_a_404(client):
    assert client.post("/api/books/404/return").status_code == 404
`;

const LEARNER_TS = `
test('a lent book is marked on loan', () => {
  assert.strictEqual(shelfLabel(aBook({ on_loan_to: 'Ade' })), 'Kindred — Octavia E. Butler (1979) · on loan');
});

test('a book on the shelf is not marked on loan', () => {
  assert.strictEqual(shelfLabel(aBook({})), 'Kindred — Octavia E. Butler (1979)');
});

test('the shelf sorts by title, ignoring case', () => {
  const titles = sortForShelf([aBook({ id: 1, title: 'persuasion' }), aBook({ id: 2, title: 'Emma' })]).map((b) => b.title);
  assert.deepStrictEqual(titles, ['Emma', 'persuasion']);
});
`;

const DECLARATION = 'declare const test: (name: string, fn: () => void | Promise<void>) => void;';

describe('a nine-test suite in the Testing room counts as nine', () => {
  const counted = (source: string, language: string) => countTestMethods(stripCodeComments(source, language), language);

  it.each(['files', 'reference'])('%s/web/src/lib/acceptance.test.ts declares test as a const, never a function', (dir) => {
    const text = read(`phases/04-testing/${dir}/web/src/lib/acceptance.test.ts`);
    expect(text).toContain(`\n${DECLARATION}\n`);
    expect(text).not.toMatch(/declare function test\(/);
  });

  it('counts the starter files as they open as zero tests, and the learner suite of the 7 Oct run as 6 + 3 = 9', () => {
    const py = read('phases/04-testing/files/tests/test_acceptance.py');
    const ts = read('phases/04-testing/files/web/src/lib/acceptance.test.ts');
    expect(counted(py, 'python') + counted(ts, 'typescript')).toBe(0);
    expect(counted(py + LEARNER_PY, 'python')).toBe(6);
    expect(counted(ts + LEARNER_TS, 'typescript')).toBe(3);
    expect(counted(py + LEARNER_PY, 'python') + counted(ts + LEARNER_TS, 'typescript')).toBe(9);
  });

  it('counts the reference front-end suite as its own three tests', () => {
    expect(counted(read('phases/04-testing/reference/web/src/lib/acceptance.test.ts'), 'typescript')).toBe(3);
  });
});
