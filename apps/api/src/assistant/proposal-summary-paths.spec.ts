import { PROPOSAL_FILES_LEAD, PROPOSAL_NAMED_NOT_HELD_LEAD, checkSummaryPaths, namedNotHeldPaths, namedNotHeldSentence, proposalFilesSentence, reaskPaths, requestNamedPaths, secondAnswerKept, summaryNamedPaths } from './proposal-edits';

/*
 * The summary's paths against the proposal's files. A model's summary of a proposal may
 * name shared/contract/api.json as changed while the proposal holds design/design.json and
 * shared/contract/screens.json only, though the request said "name only the files this
 * proposal changes". The API reads which of the project's workspace paths a stored summary
 * names and, when one of them is not a file the proposal holds, stores one sentence listing
 * the files it does hold in place of the summary. The summary's own words are never edited.
 * The fixtures are three such summaries of one Design request, as a model wrote them.
 */
describe('the summary\'s paths against the proposal\'s files', () => {
  // TaskTrackr's Design phase: its three documents, and two other phases' paths a summary has named.
  const DESIGN = 'design/design.json';
  const API = 'shared/contract/api.json';
  const SCREENS = 'shared/contract/screens.json';
  const workspace = [DESIGN, API, SCREENS, 'design/contracts.json', 'api/Dockerfile', 'docker-compose.yml'];

  // Three summaries of one Design request, each naming a contract its proposal did not hold.
  const TT3 = 'Changes design/design.json (decisions) and shared/contract/api.json plus shared/contract/screens.json (contracts). Check the exact decision wording, endpoint paths and the overdue empty-state sentence before accepting.';
  const TT4 = 'Changed design/design.json decisions to exactly D1 and D2, preserving the model and operations. Changed shared/contract/api.json and shared/contract/screens.json without altering their existing contract records. Before accepting, check that the preserved contracts match the requested operation and screen details.';
  const TT5 = 'Changed design/design.json decisions, shared/contract/api.json contracts, and shared/contract/screens.json screen empty state. Check the exact decision wording and contract entries before accepting.';
  // A Design summary whose proposal held all three documents: it names only held files.
  const HELD_ONLY = 'Changes design/design.json with the Task, List, Tag and TaskTag model, traced operations, and sequence; shared/contract/api.json with task/tag tables, complete operation contracts, query rules, and errors; and shared/contract/screens.json with the overdue screen and story coverage. Before accepting, check that the saved API shapes and operation names match the implementation conventions, especially the existing createTask reference and the overdue date boundary.';
  // A summary that names no path (a Requirements summary with its one path taken out).
  const NO_PATH = 'Changed all story sections: title, persona, capability, benefit, criteria, scope exclusions, and notes. Check the complete JSON record before accepting it.';

  describe('the recogniser: a path is named when one of the workspace\'s paths stands in the summary as a whole token', () => {
    it.each([
      ['the first Design summary', TT3, [DESIGN, API, SCREENS]],
      ['the second Design summary', TT4, [DESIGN, API, SCREENS]],
      ['the third Design summary', TT5, [DESIGN, API, SCREENS]],
      ['a summary naming only held files', HELD_ONLY, [DESIGN, API, SCREENS]],
      ['a summary naming no path', NO_PATH, []],
    ])('%s names the workspace paths it holds as tokens, in the workspace\'s order', (_take, summary, named) => {
      expect(summaryNamedPaths(summary, workspace)).toEqual(named);
    });

    it('reads a path with or without backticks, before a sentence\'s or a clause\'s punctuation, and at either end of the text', () => {
      expect(summaryNamedPaths('Changed `shared/contract/api.json` only.', workspace)).toEqual([API]);
      expect(summaryNamedPaths('Changed shared/contract/api.json.', workspace)).toEqual([API]);
      expect(summaryNamedPaths('Changed shared/contract/api.json, then stopped', workspace)).toEqual([API]);
      expect(summaryNamedPaths('(shared/contract/api.json); "shared/contract/screens.json"', workspace)).toEqual([API, SCREENS]);
      expect(summaryNamedPaths('shared/contract/api.json', workspace)).toEqual([API]);
      expect(summaryNamedPaths('Changed api/Dockerfile and docker-compose.yml.', workspace)).toEqual(['api/Dockerfile', 'docker-compose.yml']);
    });

    it('does not read a longer path, a file name alone or a slash between words as a workspace path', () => {
      // A longer path that contains a workspace path is another file.
      expect(summaryNamedPaths('Changed web/shared/contract/api.json and shared/contract/api.json.bak.', workspace)).toEqual([]);
      expect(summaryNamedPaths('Changed shared/contract/api.json/v2 and shared/contract/api.jsonl.', workspace)).toEqual([]);
      expect(summaryNamedPaths('Changed shared/contract/api.json-old and shared/contract/api.json_2.', workspace)).toEqual([]);
      // A file name without its folder, and words joined by a slash (tt4's "YAML/Dockerfile", tt3's "task/tag"), name no path.
      expect(summaryNamedPaths('Check the exact YAML/Dockerfile syntax, the task/tag tables, US-5/AC-1 and api.json.', workspace)).toEqual([]);
      // Case counts: a path is the workspace's own spelling.
      expect(summaryNamedPaths('Changed Shared/Contract/API.json.', workspace)).toEqual([]);
    });

    it('names a path once however often the summary repeats it, and finds a later whole token after an embedded one', () => {
      expect(summaryNamedPaths('Changed shared/contract/api.json; check shared/contract/api.json again.', workspace)).toEqual([API]);
      expect(summaryNamedPaths('Kept x/shared/contract/api.json; changed shared/contract/api.json.', workspace)).toEqual([API]);
      expect(summaryNamedPaths('Changed shared/contract/api.json.', [API, API])).toEqual([API]);
    });
  });

  describe('the check: the file sentence alone when the summary names a path the proposal does not hold', () => {
    const sentence = (held: string[]) => `Files in this proposal: ${held.join(', ')}.`;

    it('says the sentence the ruling gives, the held paths comma-separated in the order given', () => {
      expect(PROPOSAL_FILES_LEAD).toBe('Files in this proposal: ');
      expect(proposalFilesSentence([DESIGN, SCREENS])).toBe('Files in this proposal: design/design.json, shared/contract/screens.json.');
      expect(proposalFilesSentence([SCREENS, DESIGN])).toBe('Files in this proposal: shared/contract/screens.json, design/design.json.');
      expect(proposalFilesSentence([DESIGN])).toBe('Files in this proposal: design/design.json.');
    });

    it.each([
      ['the first Design summary', TT3, [DESIGN, SCREENS], 3, 1],
      ['the second Design summary', TT4, [DESIGN], 3, 2],
      ['the third Design summary', TT5, [DESIGN, SCREENS], 3, 1],
    ])('%s: api.json claimed and not held, so the summary is not shown and the file sentence stands alone', (_take, summary, held, names, extra) => {
      const checked = checkSummaryPaths(summary, held, workspace);
      expect(checked.summary).toBe(sentence(held));
      expect(checked.summary).not.toContain(API);
      expect(checked).toEqual({ summary: sentence(held), names, held: held.length, extra, unnamed: 0 });
    });

    it('stores a summary that names only held files, or no path at all, unchanged', () => {
      expect(checkSummaryPaths(HELD_ONLY, [DESIGN, API, SCREENS], workspace)).toEqual({ summary: HELD_ONLY, names: 3, held: 3, extra: 0, unnamed: 0 });
      expect(checkSummaryPaths(NO_PATH, ['requirements/story.json'], [...workspace, 'requirements/story.json'])).toEqual({ summary: NO_PATH, names: 0, held: 1, extra: 0, unnamed: 1 });
      // screens.json held and named: no sentence for it.
      expect(checkSummaryPaths(`Changed ${SCREENS}.`, [SCREENS], workspace)).toEqual({ summary: `Changed ${SCREENS}.`, names: 1, held: 1, extra: 0, unnamed: 0 });
    });

    it('reads names, not claims: a path the summary says it did not change still replaces it with the sentence (tt3 Maintenance request 1)', () => {
      const said = 'Changes api/repository/comments.py and maintenance/change-request.json. This proposal does not change design/contracts.json or shared/contract/api.json.';
      const held = ['maintenance/change-request.json', 'api/repository/comments.py'];
      const checked = checkSummaryPaths(said, held, [...workspace, ...held]);
      expect(checked).toEqual({ summary: 'Files in this proposal: maintenance/change-request.json, api/repository/comments.py.', names: 4, held: 2, extra: 2, unnamed: 0 });
    });

    it('counts a held path the workspace list leaves out, and a named path held twice once', () => {
      // The held paths are recognised whether or not the workspace list carries them.
      expect(checkSummaryPaths(`Changed ${DESIGN} and ${API}.`, [DESIGN], [API])).toEqual({ summary: sentence([DESIGN]), names: 2, held: 1, extra: 1, unnamed: 0 });
      expect(checkSummaryPaths(`Changed ${DESIGN}.`, [DESIGN], [DESIGN, DESIGN])).toEqual({ summary: `Changed ${DESIGN}.`, names: 1, held: 1, extra: 0, unnamed: 0 });
    });

    it('leaves the summary unchanged when the proposal holds no file, since there is nothing to list', () => {
      expect(checkSummaryPaths(TT5, [], workspace)).toEqual({ summary: TT5, names: 3, held: 0, extra: 3, unnamed: 0 });
    });
  });
  /*
   * The under-claim. A merged Design proposal may hold design/design.json (with decision D1)
   * and shared/contract/api.json while its summary reads "Changes only
   * shared/contract/api.json: ...", so the card says "2 documents" while the summary says one.
   * Beside a path named and not held, the check also appends its one sentence when the
   * summary names at least one held file and the proposal holds a file the summary does not
   * name; a summary naming no path, or naming every held file and no other, is kept as it is,
   * and the words are never rewritten. The fixtures are two such merged Design summaries as
   * the API stored them, with the proposal's files in its own order.
   */
  describe('the under-claim: one sentence appended when the summary names a held file and leaves another out', () => {
    const sentence = (held: string[]) => `Files in this proposal: ${held.join(', ')}.`;
    // Both merged Design proposals held these two files, in this order.
    const MERGED = [DESIGN, API];
    const ST5 = 'Changes only shared/contract/api.json: adds the Book entity, four endpoint records, and the error catalogue. Check the endpoint fields, refusal statuses and codes before accepting it.';
    const ST4 = 'Changed shared/contract/api.json with the Book entity, four operation endpoints, refusal statuses and codes, and the error catalogue. Check the contract fields and endpoint count before accepting it.';
    // A Maintenance proposal's three files, in the proposal's order.
    const CHANGE = 'maintenance/change-request.json';
    const SHELF_PY = 'api/shelf.py';
    const SHELF_TS = 'web/src/lib/shelf.ts';
    const THREE = [CHANGE, SHELF_PY, SHELF_TS];
    const shelf = [...workspace, ...THREE, 'requirements/story.json'];

    it.each([
      ['the first merged summary', ST5],
      ['the second merged summary', ST4],
    ])('%s: the merged Design summary names the contract and not design/design.json, so it is kept word for word and the sentence lists both files', (_take, summary) => {
      const checked = checkSummaryPaths(summary, MERGED, workspace);
      expect(checked.summary).toBe(`${summary} Files in this proposal: design/design.json, shared/contract/api.json.`);
      expect(checked.summary.startsWith(`${summary} `)).toBe(true);
      expect(checked).toEqual({ summary: `${summary} ${sentence(MERGED)}`, names: 1, held: 2, extra: 0, unnamed: 1 });
    });

    it('names one of three held files: the sentence lists all three in the proposal\'s order', () => {
      const said = `Changes ${SHELF_TS} for surname, title and id ordering. Check the ordering before accepting.`;
      expect(checkSummaryPaths(said, THREE, shelf)).toEqual({ summary: `${said} Files in this proposal: maintenance/change-request.json, api/shelf.py, web/src/lib/shelf.ts.`, names: 1, held: 3, extra: 0, unnamed: 2 });
      // Two of three named: still one file left out, so the same sentence.
      const two = `Changes ${SHELF_PY} and ${SHELF_TS}. Check the ordering before accepting.`;
      expect(checkSummaryPaths(two, THREE, shelf)).toEqual({ summary: `${two} ${sentence(THREE)}`, names: 2, held: 3, extra: 0, unnamed: 1 });
    });

    it('keeps a summary that names every held file and no other as it is, however the files are ordered in it', () => {
      const all = 'Changes api/shelf.py and web/src/lib/shelf.ts for surname, title, and id ordering, and maintenance/change-request.json with the impact and test record. Check the ordering and lending, returning, and author-filter regression cases before accepting.';
      expect(checkSummaryPaths(all, THREE, shelf)).toEqual({ summary: all, names: 3, held: 3, extra: 0, unnamed: 0 });
      const both = `Changes \`${API}\` and \`${DESIGN}\`.`;
      expect(checkSummaryPaths(both, MERGED, workspace)).toEqual({ summary: both, names: 2, held: 2, extra: 0, unnamed: 0 });
    });

    it('keeps a summary that names no path as it is, however many held files it leaves out, and counts them', () => {
      const none = 'Adds the Book entity, four endpoint records, and the error catalogue. Check the endpoint fields before accepting it.';
      expect(checkSummaryPaths(none, MERGED, workspace)).toEqual({ summary: none, names: 0, held: 2, extra: 0, unnamed: 2 });
      expect(checkSummaryPaths(NO_PATH, THREE, shelf)).toEqual({ summary: NO_PATH, names: 0, held: 3, extra: 0, unnamed: 3 });
      // A held path only inside a longer path, or a file name alone, is not a name: still no path named.
      const near = 'Changes web/shared/contract/api.json and design.json only.';
      expect(checkSummaryPaths(near, MERGED, workspace)).toEqual({ summary: near, names: 0, held: 2, extra: 0, unnamed: 2 });
    });

    it('gives the sentence alone, once, when a summary both names a path not held and leaves a held file out', () => {
      const said = `Changed ${DESIGN} and ${API}.`;
      const checked = checkSummaryPaths(said, [DESIGN, SCREENS], workspace);
      expect(checked).toEqual({ summary: sentence([DESIGN, SCREENS]), names: 2, held: 2, extra: 1, unnamed: 1 });
      expect(checked.summary.split('Files in this proposal').length).toBe(2);
      // A summary naming only a path the proposal does not hold is replaced by the sentence, every held file in it.
      expect(checkSummaryPaths(`Changed ${API}.`, [SCREENS, DESIGN], workspace)).toEqual({ summary: sentence([SCREENS, DESIGN]), names: 1, held: 2, extra: 1, unnamed: 2 });
    });

    it('st5\'s Design request 2, which named the held design.json and the contract it did not hold, is replaced by the one sentence', () => {
      const said = 'Changes `design/design.json` by replacing the decisions section with D1. Changes `shared/contract/api.json` with the four endpoint records, Book entity, and error catalogue; check the endpoint fields, refusal statuses and codes before accepting.';
      expect(checkSummaryPaths(said, [DESIGN], workspace)).toEqual({ summary: 'Files in this proposal: design/design.json.', names: 2, held: 1, extra: 1, unnamed: 0 });
    });
  });

  /*
   * A Deployment proposal for "fix the web service's API address" may hold one field of
   * deploy/services.json while the model's summary also claims edits to
   * deployment/runbook.json; shown under "What this proposal changes", even followed by
   * "Files in this proposal: deploy/services.json.", it would state a false claim. These rows give no editable list (tests only; the route always
   * gives it), and without it a summary that names a project file the proposal does not hold
   * is taken as a false claim about the proposal, so its words are not shown: the stored summary
   * is the file sentence alone, built from the proposal's own files. With the list, only an
   * editable unheld path, or unheld paths beside no held file, change the summary (see
   * below). The words are never edited; the under-claim and a summary that names exactly
   * the held files are handled as above.
   */
  describe('a summary naming a project file the proposal does not hold is replaced by the file sentence alone', () => {
    const SERVICES = 'deploy/services.json';
    const RUNBOOK = 'deployment/runbook.json';
    const deployment = [SERVICES, RUNBOOK, 'docker-compose.yml', 'api/Dockerfile', '.github/workflows/ci.yml'];
    const SEEN = 'Changed deploy/services.json: web.env.API_URL. Changed deployment/runbook.json: incident rootCause, fix, actionItem, and timeline. Before accepting, run the selfcheck and drill, then verify the saved incident record matches the drill findings.';

    it('the summary seen on 17 Nov with files = [deploy/services.json] comes out as the file sentence alone, with no runbook in it', () => {
      const checked = checkSummaryPaths(SEEN, [SERVICES], deployment);
      expect(checked).toEqual({ summary: 'Files in this proposal: deploy/services.json.', names: 2, held: 1, extra: 1, unnamed: 0 });
      expect(checked.summary).not.toContain('runbook');
      expect(checked.summary).not.toContain('Changed');
      expect(checked.summary).toBe(proposalFilesSentence([SERVICES]));
    });

    it('the under-claim keeps the model\'s words and the appended sentence', () => {
      const said = 'Changed deploy/services.json: web.env.API_URL. Check the address before accepting.';
      expect(checkSummaryPaths(said, [SERVICES, RUNBOOK], deployment)).toEqual({ summary: `${said} Files in this proposal: deploy/services.json, deployment/runbook.json.`, names: 1, held: 2, extra: 0, unnamed: 1 });
    });

    it('a summary that names exactly the held files is unchanged', () => {
      const said = 'Changed deploy/services.json: web.env.API_URL. Check the address before accepting.';
      expect(checkSummaryPaths(said, [SERVICES], deployment)).toEqual({ summary: said, names: 1, held: 1, extra: 0, unnamed: 0 });
    });

    it('prose that only looks like a path is not a named path, so it is kept as written', () => {
      // Not a project path at all, a longer path, and a file name alone: none is named, nothing is dropped.
      const said = 'Changed deploy/services.json. Also check docs/runbook.md, web/deploy/services.json, runbook.json and the API/web split.';
      expect(checkSummaryPaths(said, [SERVICES], deployment)).toEqual({ summary: said, names: 1, held: 1, extra: 0, unnamed: 0 });
    });

    it('a summary that names a held file and an unheld one is replaced too, whatever else it says', () => {
      const said = 'Changed deploy/services.json. This proposal does not change deployment/runbook.json.';
      expect(checkSummaryPaths(said, [SERVICES], deployment).summary).toBe('Files in this proposal: deploy/services.json.');
    });
  });

  /*
   * The omission named. A first Maintenance proposal may hold the change request and
   * web/src/lib/overdue.ts while the model's summary also describes web/src/lib/overdue.test.ts;
   * the file sentence alone would say nothing about the asked-for test being missing. When the answer named a file the
   * learner may edit in this phase that the proposal does not change, the stored summary is
   * the file sentence and one sentence of the server's naming those files; the model's words
   * are not shown. A read-only file named beside a held file keeps the summary.
   */
  describe('the omission named: an editable file the answer named and the proposal does not change', () => {
    const CHANGE = 'maintenance/change-request.json';
    const HELPER = 'web/src/lib/overdue.ts';
    const TEST = 'web/src/lib/overdue.test.ts';
    const README = 'README.md';
    const editable = [CHANGE, HELPER, TEST];
    const maintenance = [...editable, README];
    const held = [CHANGE, HELPER];
    // A model's own words over a proposal that held two of the three documents.
    const SEEN = 'Changes web/src/lib/overdue.ts and web/src/lib/overdue.test.ts and records the change in maintenance/change-request.json. The test file adds the completed-yesterday regression case. Check that a completed task is never overdue.';
    const NAMED = "Files in this proposal: maintenance/change-request.json, web/src/lib/overdue.ts. The mentor's answer also named web/src/lib/overdue.test.ts; this proposal does not change it. If you wanted it changed, ask again for it.";

    it('words one file and several in the server\'s sentence, which says named, never changed', () => {
      expect(PROPOSAL_NAMED_NOT_HELD_LEAD).toBe("The mentor's answer also named ");
      expect(namedNotHeldSentence([TEST])).toBe("The mentor's answer also named web/src/lib/overdue.test.ts; this proposal does not change it. If you wanted it changed, ask again for it.");
      expect(namedNotHeldSentence([TEST, HELPER])).toBe("The mentor's answer also named web/src/lib/overdue.test.ts, web/src/lib/overdue.ts; this proposal does not change them. If you wanted them changed, ask again for them.");
    });

    it('the summary named the test file the proposal does not hold, so the file sentence and the server\'s sentence are stored, and none of the model\'s words', () => {
      const checked = checkSummaryPaths(SEEN, held, maintenance, { editable });
      expect(checked).toEqual({ summary: NAMED, names: 3, held: 2, extra: 1, unnamed: 0 });
      expect(checked.summary).not.toContain('regression case');
      expect(checked.summary.split(PROPOSAL_FILES_LEAD)).toHaveLength(2);
    });

    it('is true when the summary names the file only to say it stays as it is', () => {
      const said = `Changes ${HELPER} and ${CHANGE}; ${TEST} is unchanged.`;
      expect(checkSummaryPaths(said, held, maintenance, { editable }).summary).toBe(NAMED);
    });

    it('names a file the route left out as unchanged even when the summary does not name it, once when it does', () => {
      const said = `Changes ${HELPER} and ${CHANGE}.`;
      expect(checkSummaryPaths(said, held, maintenance, { editable, dropped: [TEST] })).toEqual({ summary: NAMED, names: 2, held: 2, extra: 0, unnamed: 0 });
      expect(checkSummaryPaths(SEEN, held, maintenance, { editable, dropped: [TEST] }).summary).toBe(NAMED);
    });

    it('lists several files, the summary\'s in the editable order and then the dropped ones, each once', () => {
      const said = `Changes ${CHANGE}, ${TEST} and ${HELPER}.`;
      expect(checkSummaryPaths(said, [CHANGE], maintenance, { editable, dropped: ['web/src/App.tsx', TEST] }).summary)
        .toBe("Files in this proposal: maintenance/change-request.json. The mentor's answer also named web/src/lib/overdue.ts, web/src/lib/overdue.test.ts, web/src/App.tsx; this proposal does not change them. If you wanted them changed, ask again for them.");
      expect(namedNotHeldPaths(said, [CHANGE], editable, ['web/src/App.tsx', TEST])).toEqual([HELPER, TEST, 'web/src/App.tsx']);
    });

    it('keeps the summary\'s words when the unheld path it names is read-only, and names nothing for a held file', () => {
      const said = `Changes ${HELPER} and ${CHANGE}; ${README} stays as it is.`;
      expect(checkSummaryPaths(said, held, maintenance, { editable })).toEqual({ summary: said, names: 3, held: 2, extra: 1, unnamed: 0 });
      // A dropped path the proposal still holds (it cannot happen at the route) and a null summary name nothing.
      expect(namedNotHeldPaths(null, held, editable, [HELPER])).toEqual([]);
      expect(namedNotHeldPaths(null, held, editable, [TEST])).toEqual([TEST]);
    });

    it('without the editable list (tests only) replaces any summary naming an unheld path with the file sentence', () => {
      expect(checkSummaryPaths(SEEN, held, maintenance)).toEqual({ summary: proposalFilesSentence(held), names: 3, held: 2, extra: 1, unnamed: 0 });
      expect(checkSummaryPaths(`Changes ${HELPER} and ${CHANGE}.`, held, maintenance)).toEqual({ summary: `Changes ${HELPER} and ${CHANGE}.`, names: 2, held: 2, extra: 0, unnamed: 0 });
    });

    it('changes no count, and leaves a proposal that holds no file as it was', () => {
      expect(checkSummaryPaths(SEEN, [], maintenance, { editable, dropped: [TEST] })).toEqual({ summary: SEEN, names: 3, held: 0, extra: 3, unnamed: 0 });
    });
  });

  /*
   * A summary often names the thing to run after Apply by its path. In a Deployment phase where the learner may edit
   * deploy/services.json and deployment/runbook.json, ops/selfcheck.py and ops/Dockerfile are read-only and the
   * selfcheck is `python3 ops/selfcheck.py --selfcheck`. A read-only path cannot be a change the proposal holds, so
   * beside a held file it does not replace the summary; an editable one the proposal does not hold does, and so does
   * a read-only one when the summary names no held file (it then names nothing true about the proposal).
   */
  describe('a read-only path the summary names is no claimed change', () => {
    const SERVICES = 'deploy/services.json';
    const RUNBOOK = 'deployment/runbook.json';
    const editable = [SERVICES, RUNBOOK];
    const deployment = [...editable, 'ops/selfcheck.py', 'ops/Dockerfile'];
    const RUN = 'Changes deploy/services.json: web.env.API_URL becomes http://api:8000. Read the API_URL line in the comparison before explaining it. After Apply, run python3 ops/selfcheck.py --selfcheck.';

    it('keeps the summary that names the read-only selfcheck to run after Apply, with the sample\'s counts', () => {
      expect(checkSummaryPaths(RUN, [SERVICES], deployment, { editable })).toEqual({ summary: RUN, names: 2, held: 1, extra: 1, unnamed: 0 });
      const both = 'Changes deploy/services.json. ops/Dockerfile and ops/selfcheck.py stay as they are.';
      expect(checkSummaryPaths(both, [SERVICES], deployment, { editable }).summary).toBe(both);
    });

    it('still replaces a summary naming an editable file the proposal does not hold, with the fixed sentence', () => {
      const said = `Changes ${SERVICES} and ${RUNBOOK}. After Apply, run python3 ops/selfcheck.py --selfcheck.`;
      const NAMED = "Files in this proposal: deploy/services.json. The mentor's answer also named deployment/runbook.json; this proposal does not change it. If you wanted it changed, ask again for it.";
      expect(checkSummaryPaths(said, [SERVICES], deployment, { editable })).toEqual({ summary: NAMED, names: 3, held: 1, extra: 2, unnamed: 0 });
      expect(checkSummaryPaths(`Changes ${SERVICES} and ${RUNBOOK}.`, [SERVICES], deployment, { editable }).summary).toBe(NAMED);
    });

    it('keeps the appended file sentence when a held file is not named beside the read-only one', () => {
      expect(checkSummaryPaths(RUN, [SERVICES, RUNBOOK], deployment, { editable }).summary).toBe(`${RUN} ${proposalFilesSentence([SERVICES, RUNBOOK])}`);
    });

    it('keeps a summary that names one held file and one read-only path the proposal does not hold', () => {
      const said = `Changes ${SERVICES} and ops/Dockerfile.`;
      expect(checkSummaryPaths(said, [SERVICES], deployment, { editable })).toEqual({ summary: said, names: 2, held: 1, extra: 1, unnamed: 0 });
    });

    it('replaces with the file sentence alone a summary naming only a read-only path the proposal does not hold', () => {
      expect(checkSummaryPaths('Changes ops/Dockerfile.', [SERVICES], deployment, { editable }))
        .toEqual({ summary: proposalFilesSentence([SERVICES]), names: 1, held: 1, extra: 1, unnamed: 1 });
    });

    it('without the editable list (tests only; the route always gives it) still replaces it', () => {
      expect(checkSummaryPaths(RUN, [SERVICES], deployment).summary).toBe(proposalFilesSentence([SERVICES]));
      expect(checkSummaryPaths(`Changes ${SERVICES} and ops/Dockerfile.`, [SERVICES], deployment).summary).toBe(proposalFilesSentence([SERVICES]));
    });
  });

  /*
   * What asks a first proposal for once more is read only from what is certain: a path the learner's request
   * writes out that the summary names too and the proposal does not hold, or an entry the route left out as unchanged.
   * Prose about a file the request did not name asks for nothing, whatever it says the file is for.
   */
  describe('the files that ask a first proposal for once more', () => {
    const editable = ['web/src/lib/overdue.ts', 'web/src/lib/overdue.test.ts', 'maintenance/change-request.json'];
    const held = ['maintenance/change-request.json', 'web/src/lib/overdue.ts'];
    const TEST = 'web/src/lib/overdue.test.ts';
    it.each([
      ['says the file stays as it is', `Changes web/src/lib/overdue.ts. ${TEST} stays as it is.`],
      ['names the file to run after Apply', `Changes web/src/lib/overdue.ts. After Apply, run ${TEST}.`],
      ['describes the file as changed', `Changes web/src/lib/overdue.ts and ${TEST}.`],
    ])('finds none when the request does not write the path out and the summary %s', (_case, summary) => {
      expect(reaskPaths(summary, 'Fix the overdue badge and add a regression test.', held, editable)).toEqual([]);
      // The stored summary still names it.
      expect(namedNotHeldPaths(summary, held, editable)).toEqual([TEST]);
    });
    it('finds a path the request writes out and the summary names, and never one the proposal holds or the summary leaves out', () => {
      const request = `Fix web/src/lib/overdue.ts and add the case to ${TEST}.`;
      expect(reaskPaths(`Changes web/src/lib/overdue.ts. After Apply, run ${TEST}.`, request, held, editable)).toEqual([TEST]);
      expect(reaskPaths('Changes web/src/lib/overdue.ts.', request, held, editable)).toEqual([]);
      expect(reaskPaths(null, request, held, editable)).toEqual([]);
      expect(reaskPaths(`Changes ${TEST}.`, request, [...held, TEST], editable)).toEqual([]);
    });
    it('finds an entry left out as unchanged whatever the request and the summary say', () => {
      expect(reaskPaths(null, 'Fix the badge.', held, editable, [TEST])).toEqual([TEST]);
    });
  });

  /*
   * A Maintenance request may name its files by bare file name. The request is read
   * the way the web card's "Your request names ..." line reads it (namedNotHeld.ts): the full path, or a file name exactly
   * one editable file has, as a whole token.
   */
  describe('the editable files the learner\'s request names', () => {
    const CHANGE = 'maintenance/change-request.json';
    const HELPER = 'web/src/lib/overdue.ts';
    const TEST = 'web/src/lib/overdue.test.ts';
    const editable = [CHANGE, HELPER, TEST];
    const V6 = 'Update overdue.ts so completed tasks return false; keep the date rule. Add one regression test in overdue.test.ts for a completed task due yesterday. Draft the change request with both files in impact and tests not run. Include all three documents.';
    const SHORT = 'Make completed tasks return false in isOverdue, add a regression test, and draft the change request. Keep the date rule.';
    // A model's own words over a proposal that held two of the three documents.
    const SEEN = 'Changes web/src/lib/overdue.ts and web/src/lib/overdue.test.ts and records the change in maintenance/change-request.json. The test file adds the completed-yesterday regression case. Check that a completed task is never overdue.';

    it('reads the request\'s two file names as the two nested paths, and "the change request" as no path', () => {
      expect(requestNamedPaths(V6, editable)).toEqual([HELPER, TEST]);
      expect(requestNamedPaths(SHORT, editable)).toEqual([]);
    });

    it('re-asks the answer to that request that leaves out overdue.test.ts, and not the request that names no file', () => {
      expect(reaskPaths(SEEN, V6, [CHANGE, HELPER], editable)).toEqual([TEST]);
      expect(reaskPaths(SEEN, SHORT, [CHANGE, HELPER], editable)).toEqual([]);
      expect(reaskPaths(SEEN, V6, editable, editable)).toEqual([]);
    });

    it('never finds "overdue.ts" inside "overdue.test.ts" or inside a longer path', () => {
      expect(requestNamedPaths('Add one regression test in overdue.test.ts.', editable)).toEqual([TEST]);
      expect(requestNamedPaths('Add a case to lib/overdue.test.ts and src/lib/overdue.ts.', editable)).toEqual([]);
      expect(reaskPaths(`Changes ${HELPER} and ${TEST}.`, 'Add one regression test in overdue.test.ts.', [TEST], editable)).toEqual([]);
      expect(reaskPaths(`Changes ${TEST}; ${HELPER} stays as it is.`, 'Add one regression test in overdue.test.ts.', [TEST], editable)).toEqual([]);
    });

    it('does not read a file name two editable files share, while their full paths still count', () => {
      const shared = [...editable, 'api/overdue.ts'];
      expect(requestNamedPaths('Update overdue.ts and overdue.test.ts.', shared)).toEqual([TEST]);
      expect(requestNamedPaths('Update web/src/lib/overdue.ts.', shared)).toEqual([HELPER]);
      expect(reaskPaths(`Changes ${TEST}. ${HELPER} is next.`, 'Update overdue.ts and overdue.test.ts.', [TEST], shared)).toEqual([]);
    });

    it('is case-sensitive and reads full stops, quotes and brackets beside a name as the name\'s end', () => {
      expect(requestNamedPaths('Update Overdue.ts.', editable)).toEqual([]);
      expect(requestNamedPaths('Update "overdue.ts" (and `overdue.test.ts`).', editable)).toEqual([HELPER, TEST]);
      expect(requestNamedPaths('Update overdue.tsx and overdue.ts.bak.', editable)).toEqual([]);
    });
  });
  describe('which answer a completeness re-ask keeps', () => {
    const wanted = ['a.ts', 'b.ts', 'c.ts'];
    it('keeps the second only when it holds every file the first held and at least as many of what was named', () => {
      expect(secondAnswerKept(['a.ts'], ['a.ts', 'b.ts'], wanted)).toBe(true);
      // More of what was named, but without a.ts, which the first held: the first stands.
      expect(secondAnswerKept(['a.ts'], ['b.ts', 'c.ts'], wanted)).toBe(false);
      expect(secondAnswerKept(['a.ts'], ['a.ts'], wanted)).toBe(true);
      expect(secondAnswerKept(['a.ts', 'b.ts'], ['c.ts'], wanted)).toBe(false);
      expect(secondAnswerKept(['a.ts'], ['b.ts'], wanted)).toBe(false);
      // A file nothing named counts for neither answer.
      expect(secondAnswerKept(['a.ts'], ['b.ts', 'x.ts'], wanted)).toBe(false);
      expect(secondAnswerKept(['a.ts'], ['a.ts', 'x.ts'], wanted)).toBe(true);
    });

    it('keeps the first when it held only the code fix and the second holds the record and the test', () => {
      const CHANGE = 'maintenance/change-request.json';
      const HELPER = 'web/src/lib/overdue.ts';
      const TEST = 'web/src/lib/overdue.test.ts';
      const named = [HELPER, ...requestNamedPaths('Update overdue.ts so completed tasks return false; keep the date rule. Add one regression test in overdue.test.ts for a completed task due yesterday. Draft the change request with both files in impact and tests not run. Include all three documents.', [CHANGE, HELPER, TEST]), CHANGE];
      expect(secondAnswerKept([HELPER], [CHANGE, TEST], named)).toBe(false);
      expect(secondAnswerKept([HELPER], [HELPER, CHANGE, TEST], named)).toBe(true);
    });
  });
});
