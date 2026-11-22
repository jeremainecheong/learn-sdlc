/**
 * Seen on the preview: the learner asked "Update overdue.ts ... Add one
 * regression test in overdue.test.ts ..." and the proposal held
 * maintenance/change-request.json and web/src/lib/overdue.ts only, and nothing
 * on the card said the asked-for test file was missing. namedNotHeld reads the
 * request literally (full path, or a base name exactly one editable file has,
 * as a whole token, case-sensitive) and namedNotHeldLine says it in one line,
 * on the Agentic card under the files list and in the Compare window's head.
 * A card with a Discard button says "discard this proposal and ask again"; a
 * plain code card, which has none, says "ask again for it".
 */
import { repoFile } from './support/paths';
import { describe, expect, it } from 'vitest';
import { SUMMARY_NAMED_NOT_HELD_LEAD, namedNotHeld, namedNotHeldLine, summaryNamedNotHeld } from '@/components/workspace/mentor/namedNotHeld';

const EDITABLE = ['maintenance/change-request.json', 'web/src/lib/overdue.ts', 'web/src/lib/overdue.test.ts', 'web/src/App.tsx', 'design/contracts.json'];
const HELD = ['maintenance/change-request.json', 'web/src/lib/overdue.ts'];
const LIVE = 'Update overdue.ts so a task due today is not overdue. Add one regression test in overdue.test.ts for it.';

describe('namedNotHeld', () => {
  it('finds the test file the live request named and the proposal lacks, by base name, and not overdue.ts inside it', () => {
    expect(namedNotHeld(LIVE, EDITABLE, HELD)).toEqual(['web/src/lib/overdue.test.ts']);
    expect(namedNotHeld('Add one regression test in overdue.test.ts.', EDITABLE, ['web/src/lib/overdue.test.ts'])).toEqual([]);
  });
  it('reads a full path, keeps the order the request names them, and is case-sensitive', () => {
    expect(namedNotHeld('Change design/contracts.json and App.tsx.', EDITABLE, HELD)).toEqual(['design/contracts.json', 'web/src/App.tsx']);
    expect(namedNotHeld('Change app.tsx.', EDITABLE, HELD)).toEqual([]);
  });
  it('says nothing when every named file is held, when none is named, or when the request or file list is not at hand', () => {
    expect(namedNotHeld('Update overdue.ts only.', EDITABLE, HELD)).toEqual([]);
    expect(namedNotHeld('Make the badge red.', EDITABLE, HELD)).toEqual([]);
    expect(namedNotHeld(null, EDITABLE, HELD)).toEqual([]);
    expect(namedNotHeld(LIVE, null, HELD)).toEqual([]);
  });
  it('does not read a base name two editable files share', () => {
    expect(namedNotHeld('Fix index.ts.', ['a/index.ts', 'b/index.ts'], [])).toEqual([]);
    expect(namedNotHeld('Fix a/index.ts.', ['a/index.ts', 'b/index.ts'], [])).toEqual(['a/index.ts']);
  });
  it('does not read intent: "leave overdue.test.ts alone" names it too', () => {
    expect(namedNotHeld('Leave overdue.test.ts alone.', EDITABLE, HELD)).toEqual(['web/src/lib/overdue.test.ts']);
  });
});

describe('namedNotHeldLine', () => {
  it('words one file, several files, and a card without Discard', () => {
    expect(namedNotHeldLine(['web/src/lib/overdue.test.ts'], true)).toBe(
      'Your request names web/src/lib/overdue.test.ts. This proposal does not change it. If you wanted it changed, discard this proposal and ask again.',
    );
    expect(namedNotHeldLine(['a.ts', 'b.ts'], true)).toBe(
      'Your request names a.ts, b.ts. This proposal does not change them. If you wanted them changed, discard this proposal and ask again.',
    );
    expect(namedNotHeldLine(['a.ts'], false)).toBe('Your request names a.ts. This proposal does not change it. If you wanted it changed, ask again for it.');
    expect(namedNotHeldLine([], true)).toBeNull();
  });
  // The wiring (card and Compare head) is pinned by mounting the real panel: named-not-held-mounted.test.tsx.
});

/*
 * The API now stores, after its file sentence, its own sentence naming the editable files the mentor's answer
 * named and the proposal does not change ("The mentor's answer also named web/src/lib/overdue.test.ts; this proposal
 * does not change it. ..."). The card shows that summary, so for a file that sentence names this line stands down:
 * the same missing file is said once. A file the request names and the sentence does not keeps its line.
 */
describe('the line stands down for a file the API\'s summary sentence already names', () => {
  const FILES = 'Files in this proposal: maintenance/change-request.json, web/src/lib/overdue.ts.';
  const sentence = (paths: string[]) => {
    const them = paths.length === 1 ? 'it' : 'them';
    return `${SUMMARY_NAMED_NOT_HELD_LEAD}${paths.join(', ')}; this proposal does not change ${them}. If you wanted ${them} changed, ask again for ${them}.`;
  };
  const SERVER = `${FILES} ${sentence(['web/src/lib/overdue.test.ts'])}`;

  it('keeps the lead and the sentence\'s shape to the API\'s own bytes, read from its source', () => {
    const api = repoFile('apps/api/src/assistant/proposal-edits.ts');
    expect(api).toContain(`export const PROPOSAL_NAMED_NOT_HELD_LEAD = "${SUMMARY_NAMED_NOT_HELD_LEAD}";`);
    expect(api).toContain('return `${PROPOSAL_NAMED_NOT_HELD_LEAD}${paths.join(\', \')}; this proposal does not change ${them}. If you wanted ${them} changed, ask again for ${them}.`;');
    expect(api).toContain('return { summary: `${proposalFilesSentence(held)} ${namedNotHeldSentence(missing)}`, ...counts };');
  });

  it('reads the paths of the API\'s sentence only right after its file sentence over the held files', () => {
    expect(summaryNamedNotHeld(SERVER, HELD)).toEqual(['web/src/lib/overdue.test.ts']);
    expect(summaryNamedNotHeld(`${FILES} ${sentence(['web/src/lib/overdue.test.ts', 'web/src/App.tsx'])}`, HELD)).toEqual(['web/src/lib/overdue.test.ts', 'web/src/App.tsx']);
    // The model's own words, the held files in another order, the file sentence alone, or nothing: no paths.
    expect(summaryNamedNotHeld(sentence(['web/src/lib/overdue.test.ts']), HELD)).toEqual([]);
    expect(summaryNamedNotHeld(SERVER, [...HELD].reverse())).toEqual([]);
    expect(summaryNamedNotHeld(FILES, HELD)).toEqual([]);
    expect(summaryNamedNotHeld(null, HELD)).toEqual([]);
    expect(summaryNamedNotHeld(SERVER, [])).toEqual([]);
  });

  it('leaves out the file the sentence names, and keeps the line for a file only the request names', () => {
    expect(namedNotHeld(LIVE, EDITABLE, HELD, SERVER)).toEqual([]);
    expect(namedNotHeld('Change overdue.test.ts and App.tsx.', EDITABLE, HELD, SERVER)).toEqual(['web/src/App.tsx']);
    // Without the sentence (a summary in the model's words, the file sentence alone, or none) the line names every file not held.
    expect(namedNotHeld(LIVE, EDITABLE, HELD, FILES)).toEqual(['web/src/lib/overdue.test.ts']);
    expect(namedNotHeld(LIVE, EDITABLE, HELD, 'Changes web/src/lib/overdue.test.ts too.')).toEqual(['web/src/lib/overdue.test.ts']);
    expect(namedNotHeld(LIVE, EDITABLE, HELD, null)).toEqual(['web/src/lib/overdue.test.ts']);
  });
});
