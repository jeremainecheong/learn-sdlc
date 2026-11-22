/**
 * The teacher guide (docs/teacher-project-upload.md, drawn
 * in the app through lib/teacher-guide-doc.generated.ts) agrees with the shared
 * tables it sits beside.
 *
 * - Section 7's refusal table holds exactly the 29 wire codes of
 *   `UPLOAD_REFUSAL_HELP`, in `UPLOAD_REFUSAL_CODES` order, each with the page's
 *   own sentence. It carries no fix column, because the guide page
 *   draws every fix in its own RefusalTable under the document and the upload
 *   page draws one under every refusal; the fix is shown once, and section 7
 *   says where. The no-code fallback is said once, in its own words.
 * - What section 2 and section 7 say about a title's address is
 *   what the API does (mintTeacherSlug adds -2, -3 to a taken or reserved
 *   address; no upload answers RESERVED_NAME).
 * - Every `docsAnchor` and `guideAnchor` in teacher-path.ts lands on a section the
 *   generated module holds (or one of the page's own sections).
 * - The guide's required sections exist, and the document names no release,
 *   no course and no project slug.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath, webPath } from './support/paths';
import { closureText } from './support/source-text';
import {
  GUIDE_STEPS,
  NO_INTERVIEW_HINT,
  TEACHER_GUIDE_OWN_SECTIONS,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_CODES,
  UPLOAD_REFUSAL_FALLBACK,
  UPLOAD_REFUSAL_HELP,
  UPLOAD_WARNINGS_SENTENCE,
} from '@learnsdlc/shared';
import { OLDER_FORMAT_SENTENCE } from '../components/workspace/panels/requirements/useStory';
import { OLDER_FORMAT_NOTICE } from '../components/staff/projects/requirements/builder-model';

const DOC = repoPath('docs/teacher-project-upload.md');
const GENERATED = webPath('lib/teacher-guide-doc.generated.ts');

const doc = readFileSync(DOC, 'utf8').replace(/\r\n?/g, '\n');
const generated = readFileSync(GENERATED, 'utf8');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The body of one `## ` section, its heading excluded, up to the next `## ` heading outside a code fence. */
function sectionOf(heading: string): string {
  const at = doc.indexOf(`\n## ${heading}\n`);
  if (at < 0) return '';
  const lines = doc.slice(at + heading.length + 5).split('\n');
  let fenced = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/** A table row's cells, split on the pipes that are not escaped. */
function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** Section 7's rows whose first cell is a code: `| \`CODE\` | sentence |`. */
const refusalRows = sectionOf('7. Upload refusals')
  .split('\n')
  .filter((line) => /^\|\s*`[A-Z0-9_]+`\s*\|/.test(line))
  .map(cellsOf)
  .map(([code, sentence, ...rest]) => ({ code: code.replace(/`/g, ''), sentence, rest }));

/** The title the guide page gives the section its RefusalTable sits in. */

/** The section ids the generated module gives its `##` headings. */
const sectionIds = [...generated.matchAll(/^ {2}\{ id: ("(?:[^"\\]|\\.)*"), title: /gm)].map((match) => JSON.parse(match[1]) as string);
const ids = new Set<string>([...sectionIds, ...Object.values(TEACHER_GUIDE_OWN_SECTIONS)]);

describe('section 7 is UPLOAD_REFUSAL_HELP', () => {
  it('holds exactly the 29 wire codes, once each, in the shared order', () => {
    expect(Object.keys(UPLOAD_REFUSAL_HELP)).toHaveLength(29);
    expect(refusalRows.map((row) => row.code)).toEqual([...UPLOAD_REFUSAL_CODES]);
    expect([...refusalRows.map((row) => row.code)].sort()).toEqual(Object.keys(UPLOAD_REFUSAL_HELP).sort());
  });

  it("says each code's sentence as the page shows it", () => {
    expect(refusalRows.length).toBeGreaterThan(0);
    for (const row of refusalRows) {
      const code = row.code as keyof typeof UPLOAD_REFUSAL_HELP;
      expect(row.sentence, row.code).toBe(UPLOAD_REFUSALS[code]);
    }
  });

  it('shows each fix once: no fix column, and it says where the fixes are', () => {
    const body = sectionOf('7. Upload refusals');
    expect(body.split('\n')).toContain('| Code | What the page says |');
    for (const row of refusalRows) expect(row.rest, row.code).toEqual([]);
    const flat = oneLine(body);
    for (const code of UPLOAD_REFUSAL_CODES) expect(flat, code).not.toContain(UPLOAD_REFUSAL_HELP[code].fix);
    expect(flat).not.toMatch(/as the last column does|How to fix \|/);
    // The section the page draws the fixes in, by the title the page gives it.
    const title = /title="(Every refusal, and how to fix it)"/.exec(closureText('TeacherGuide'))?.[1];
    expect(title).toBe('Every refusal, and how to fix it');
    expect(flat).toContain(
      `How to fix each one is on the Teacher guide page in the app, under **${title}**, and under every refusal on the upload page.`,
    );
    // Section 2 does not promise every fix in section 7.
    expect(oneLine(sectionOf('2. Upload'))).not.toMatch(/with every fix/);
  });

  it('says the no-code fallback in its own words', () => {
    const body = oneLine(sectionOf('7. Upload refusals'));
    expect(body).toContain(`"${UPLOAD_REFUSAL_FALLBACK.title}"`);
    expect(body).toContain(UPLOAD_REFUSAL_FALLBACK.fix);
  });
});

describe("a title's address, as the API makes it", () => {
  it('section 2 says a taken or reserved address gets a number, and section 7 says no upload answers RESERVED_NAME', () => {
    const upload = oneLine(sectionOf('2. Upload'));
    expect(upload).toContain(
      'If another project already uses that address, or the platform keeps it for its own project, a number is added to the end, such as `-2`, and the upload goes ahead.',
    );
    expect(oneLine(sectionOf('7. Upload refusals'))).toContain(
      'An upload is not refused with `RESERVED_NAME` today: when the address a title makes is taken or kept for the platform, a number is added to it instead (section 2).',
    );
  });
});

describe('every anchor teacher-path names lands on the generated guide', () => {
  it('the generated module holds the sections the shared tables point at', () => {
    for (const slug of [
      'start-here',
      'the-whole-path-at-a-glance',
      '1-prepare-the-archive',
      '2-upload',
      '3-edit-the-draft',
      '4-deep-validation',
      'preview-a-draft-as-a-learner',
      '5-publish-and-assign',
      '6-the-seven-run-shapes',
      '7-upload-refusals',
      '8-export-a-version',
      '9-sign-off-one-task-for-many-learners',
      '10-download-quiz-results',
      'what-uploads-do-not-do-yet',
    ]) {
      expect(sectionIds, slug).toContain(slug);
    }
    expect(sectionIds).not.toContain('parts-that-could-have-been-held-back');
    // the interview is typed in the editor's Stakeholder step; no stories file is read
    expect(sectionIds).not.toContain('an-interview-from-your-reference-stories');
  });

  it('every step docsAnchor and every refusal guideAnchor is a section the page has', () => {
    for (const step of GUIDE_STEPS) expect(ids.has(step.docsAnchor), `${step.key} -> ${step.docsAnchor}`).toBe(true);
    for (const code of UPLOAD_REFUSAL_CODES) {
      expect(ids.has(UPLOAD_REFUSAL_HELP[code].guideAnchor), `${code} -> ${UPLOAD_REFUSAL_HELP[code].guideAnchor}`).toBe(true);
    }
    expect(ids.has(UPLOAD_REFUSAL_FALLBACK.guideAnchor)).toBe(true);
  });

  it("every in-page link in the document lands on one of its own sections", () => {
    const links = [...doc.matchAll(/\]\(#([^)\s]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(sectionIds, link).toContain(link);
  });
});

describe('the guide gives no interview away and says what the page does', () => {
  /**
   * The guide page's module ships in the web bundle a learner can fetch, so no
   * answer of the starter's own interview may be quoted in either document
   * (the starter is served staff-only because those answers are sealed).
   */
  const STARTER_INTERVIEW = repoPath('apps/api/test/fixtures/upload-packs/starter/phases/01-requirements/interview.json');
  const AUTHORING = repoPath('docs/authoring-format.md');
  const quoted = (line: string) =>
    line
      .replace(/^#+\s*/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^(\*\*)?AC-\d+(\*\*)?\s+/, '')
      .replace(/^[A-Z]+-\d+\s+/, '')
      .trim();

  it("quotes no answer of the starter's interview, in either document or the generated module", () => {
    const facts = (JSON.parse(readFileSync(STARTER_INTERVIEW, 'utf8')) as { facts: { answer: string }[] }).facts;
    const lines = facts.map((fact) => quoted(fact.answer)).filter((line) => line.length >= 20);
    expect(lines.length).toBeGreaterThan(4);
    const texts = {
      doc: oneLine(doc),
      authoring: oneLine(readFileSync(AUTHORING, 'utf8')),
      generated: oneLine(generated.replace(/\\n/g, '\n').replace(/\\"/g, '"')),
    };
    for (const [where, text] of Object.entries(texts)) {
      for (const line of lines) expect(text.includes(oneLine(line)), `${where}: ${line}`).toBe(false);
    }
  });

  it('keeps every line of a code example short enough to read without scrolling sideways', () => {
    let fenced = false;
    for (const line of doc.split('\n')) {
      if (/^(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) expect(line.length, line).toBeLessThanOrEqual(72);
    }
  });

  it('says an upload that changed the archive shows a panel with Open the draft, and any other upload opens the editor', () => {
    const upload = oneLine(sectionOf('2. Upload'));
    expect(upload).not.toContain('When the upload is accepted, the editor opens on the new draft.');
    expect(upload).toContain('**Open the draft**');
    expect(upload).toContain(`"${UPLOAD_WARNINGS_SENTENCE}"`);
  });

  it('says the Requirements phase in five steps, with the floor, the refusal and the conversion', () => {
    const prepare = oneLine(sectionOf('1. Prepare the archive'));
    // the upload door's detail line for an archive that still holds a stories file
    expect(prepare).toMatch(/stories file[^.]*imports nothing/);
    expect(prepare).toMatch(/no longer read, and asks you to type the stakeholder's facts in the editor/);
    expect(prepare).toMatch(/older Requirements phase is converted/);
    const edit = oneLine(sectionOf('3. Edit the draft'));
    for (const step of ['Background', 'Stakeholder', 'Provided stories', "The learner's story", 'Criteria']) {
      expect(edit, step).toContain(`**${step}.**`);
    }
    expect(edit).toContain(`"${NO_INTERVIEW_HINT}"`);
    expect(edit).toContain(`"${OLDER_FORMAT_NOTICE}"`);
    expect(edit).toContain(`"${OLDER_FORMAT_SENTENCE}"`);
    expect(edit).toMatch(/brief[^.]*stakeholder[^.]*capitals/);
  });

  it('says the preview 409 once, and promises only fast validation for the starter', () => {
    const preview = oneLine(sectionOf('Preview a draft as a learner'));
    expect(preview).toContain('Fix what Validate reports, then open the preview again.');
    expect(preview).not.toMatch(/Fix what the validation report says and open the preview again/);
    expect(oneLine(sectionOf('Start here'))).not.toMatch(/passes every check/);
    expect(oneLine(doc.slice(0, doc.indexOf('\n## ')))).not.toMatch(/authoring-format/);
  });

  // A test of its own, kept apart from the section checks above.
  it("tells a teacher to write their own interview before assigning the starter", () => {
    expect(oneLine(sectionOf('Start here'))).toMatch(/write your own stakeholder and provided stories in the Requirements builder/i);
  });
});

describe('the document is written for a teacher', () => {
  it('names no release, no course and no project slug', () => {
    expect(doc).not.toMatch(/\bR-[A-Z]\b|held back|Linux host|this release|later release/);
    expect(doc).not.toMatch(/\b(course|module|CS\d{3,4})\b/i);
    expect(doc).not.toMatch(/tasktrackr/i);
  });

  it('opens with Start here before section 1, and carries the starter warning and the preview banner', () => {
    const order = ['## Start here', '## The whole path at a glance', '## 1. Prepare the archive'].map((one) => doc.indexOf(`\n${one}\n`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const flat = oneLine(doc);
    expect(flat).toContain("Replace the starter's hidden tests before you assign it.");
    expect(flat).toContain('"Preview: nothing here is saved, graded or seen by learners"');
    expect(flat).toContain('Learners open this first.');
    expect(flat).toContain('App preview is not offered for uploaded applications.');
  });
});
