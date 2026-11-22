import type { PhaseContent } from '../content/content.types';
import { readOnlyTargets } from './agentic.service';
import {
  TRIM_NAMED_SENTENCE,
  TRIM_READ_ONLY_SENTENCE,
  TRIM_SAVED_SENTENCE,
  chatGenerationData,
  importClosure,
  namedFiles,
  proposeGenerationData,
  trimSentence,
} from './agentic-payload';

/*
 * The generation payload, trimmed behind AI_AGENTIC_PAYLOAD=trim.
 * `full` (the default) must build the whole data object byte for byte; `trim`
 * drops the duplicate saved workspace and, when the request names editable
 * files, sends those files and what they import, with the other editable
 * paths named but not shown. Read-only files only ever ride under
 * readOnlyContext.
 */

const file = (path: string, content: string, editable: boolean) => ({ path, content, editable, language: 'text' });

function phaseWith(files: ReturnType<typeof file>[]): PhaseContent {
  return { key: 'implementation', title: 'Implementation', taskPanel: 'brief', objectives: [], files } as unknown as PhaseContent;
}

const phase = phaseWith([
  file('api/app.py', 'from api.errors import NotFound\nfrom .store import Store\nimport json\n\ndef route():\n    return Store()\n', true),
  file('api/store.py', 'from api import models\n\nclass Store:\n    pass\n', true),
  file('api/models.py', 'class Task:\n    pass\n', false),
  file('api/errors.py', 'class NotFound(Exception):\n    pass\n', false),
  file('api/unused.py', 'X = 1\n', true),
  file('web/src/list.ts', "import { api } from './lib/api';\nimport type { Task } from '../types.js';\nexport const list = () => api('/tasks');\n", true),
  file('web/src/lib/api.ts', "export const api = (path: string) => fetch(path);\n", false),
  file('web/types.ts', 'export interface Task { id: number }\n', false),
  file('web/src/other.ts', 'export const other = 1;\n', true),
  file('tests/test_app.py', 'from api.app import route\n', false),
]);

const editable = Object.fromEntries(phase.files.filter(f => f.editable).map(f => [f.path, f.content]));
const extra = { designStories: [{ id: 'S-1' }] };

describe('the proposal generation payload (agentic-payload.ts)', () => {
  describe('full mode', () => {
    it('full mode returns the whole data object (deep-equal), key order included, at both sites', () => {
      const proposed = { ...editable, 'api/app.py': 'changed' };
      const chat = chatGenerationData('full', phase, { request: 'fix api/app.py', transcript: [{ learner: 'x' }], saved: editable, proposed, selectedPaths: ['api/app.py'], extra });
      const wholeData = { originalAndContinuedRequest: 'fix api/app.py', precedingConversation: [{ learner: 'x' }], savedWorkspace: editable, proposedWorkspace: proposed, ...extra };
      expect(chat).toEqual(wholeData);
      expect(JSON.stringify(chat)).toBe(JSON.stringify(wholeData));
      const propose = proposeGenerationData('full', phase, { prompt: 'fix api/app.py', workspace: editable, extra });
      expect(JSON.stringify(propose)).toBe(JSON.stringify({ prompt: 'fix api/app.py', workspace: editable, ...extra }));
      expect(trimSentence('full', chat)).toBe('');
      expect(trimSentence('full', propose)).toBe('');
    });
  });

  describe('trim mode', () => {
    it('trim with no selection sends no savedWorkspace contents', () => {
      const data = chatGenerationData('trim', phase, { request: 'tighten the wording', transcript: [], saved: editable, proposed: { ...editable }, selectedPaths: [], extra: {} });
      expect(data.savedWorkspace).toEqual({});
      expect(data.proposedWorkspace).toEqual(editable);
      expect(trimSentence('trim', data)).toBe(` ${TRIM_SAVED_SENTENCE}`);
    });

    it('trim sends savedWorkspace only for paths that differ from proposedWorkspace', () => {
      const proposed = { ...editable, 'api/unused.py': 'X = 2\n' };
      const data = chatGenerationData('trim', phase, { request: 'tighten the wording', transcript: [], saved: editable, proposed, selectedPaths: ['api/unused.py'], extra: {} });
      expect(data.savedWorkspace).toEqual({ 'api/unused.py': 'X = 1\n' });
      expect(data.proposedWorkspace).toEqual(proposed);
      // No file is sent twice with the same bytes.
      const saved = data.savedWorkspace as Record<string, string>;
      const shown = data.proposedWorkspace as Record<string, string>;
      expect(Object.keys(saved).filter(path => saved[path] === shown[path])).toEqual([]);
    });

    it('a request naming an editable file sends that file, its import closure within the phase, and the other editable paths without contents', () => {
      const data = proposeGenerationData('trim', phase, { prompt: 'In api/app.py return a 404 for a missing task.', workspace: editable, extra });
      expect(Object.keys(data.workspace as object)).toEqual(['api/app.py', 'api/store.py']);
      expect((data.workspace as Record<string, string>)['api/app.py']).toBe(editable['api/app.py']);
      expect(data.otherEditablePaths).toEqual(['api/unused.py', 'web/src/list.ts', 'web/src/other.ts']);
      expect(data.readOnlyContext).toEqual({ 'api/models.py': 'class Task:\n    pass\n', 'api/errors.py': 'class NotFound(Exception):\n    pass\n' });
      expect(data.designStories).toEqual(extra.designStories);
      expect(Object.keys(data)).toEqual(['prompt', 'workspace', 'otherEditablePaths', 'readOnlyContext', 'designStories']);
      expect(trimSentence('trim', data)).toBe(` ${TRIM_NAMED_SENTENCE('workspace')} ${TRIM_READ_ONLY_SENTENCE}`);
      // A TypeScript file: relative imports, a `.js` specifier that names a `.ts` file.
      const web = proposeGenerationData('trim', phase, { prompt: 'Make list.ts sort by id.', workspace: editable, extra: {} });
      expect(Object.keys(web.workspace as object)).toEqual(['web/src/list.ts']);
      expect(Object.keys(web.readOnlyContext as object)).toEqual(['web/src/lib/api.ts', 'web/types.ts']);
    });

    it('the chat site narrows proposedWorkspace the same way and always keeps the selected proposal\'s files', () => {
      const proposed = { ...editable, 'web/src/other.ts': 'export const other = 2;\n' };
      const data = chatGenerationData('trim', phase, { request: JSON.stringify({ currentLearnerMessage: 'also rename route in api/app.py' }), transcript: [], saved: editable, proposed, selectedPaths: ['web/src/other.ts'], extra: {} });
      expect(Object.keys(data.proposedWorkspace as object)).toEqual(['api/app.py', 'api/store.py', 'web/src/other.ts']);
      expect(data.savedWorkspace).toEqual({ 'web/src/other.ts': 'export const other = 1;\n' });
      expect(data.otherEditablePaths).toEqual(['api/unused.py', 'web/src/list.ts']);
      expect(Object.keys(data)).toEqual(['originalAndContinuedRequest', 'precedingConversation', 'savedWorkspace', 'proposedWorkspace', 'otherEditablePaths', 'readOnlyContext']);
      expect(trimSentence('trim', data)).toBe(` ${TRIM_SAVED_SENTENCE} ${TRIM_NAMED_SENTENCE('proposedWorkspace')} ${TRIM_READ_ONLY_SENTENCE}`);
    });

    it('a file name that starts a line of the chat message is named in trim mode', () => {
      // The chat request is the intent JSON, where a newline is the two characters \n.
      const request = JSON.stringify({ selectedProposalOriginalRequest: null, precedingConversation: [], currentLearnerMessage: 'Change api/store.py,\napp.py and\tlist.ts too' });
      const data = chatGenerationData('trim', phase, { request, transcript: [], saved: editable, proposed: editable, selectedPaths: [], extra: {} });
      expect(Object.keys(data.proposedWorkspace as object)).toEqual(['api/app.py', 'api/store.py', 'web/src/list.ts']);
      expect(data.otherEditablePaths).toEqual(['api/unused.py', 'web/src/other.ts']);
      expect(data.originalAndContinuedRequest).toBe(request);
    });

    it('a file name that starts a line of the selected proposal\'s original request is named in trim mode', () => {
      // The selected proposal's request is itself an intent JSON, so its newline is escaped twice.
      const original = JSON.stringify({ selectedProposalOriginalRequest: null, precedingConversation: [], currentLearnerMessage: 'Sort the tasks\nlist.ts' });
      const request = JSON.stringify({ selectedProposalOriginalRequest: original, precedingConversation: [], currentLearnerMessage: 'and keep api/store.py' });
      const data = chatGenerationData('trim', phase, { request, transcript: [], saved: editable, proposed: editable, selectedPaths: [], extra: {} });
      expect(Object.keys(data.proposedWorkspace as object)).toEqual(['api/store.py', 'web/src/list.ts']);
      expect(data.otherEditablePaths).toEqual(['api/app.py', 'api/unused.py', 'web/src/other.ts']);
      expect(data.originalAndContinuedRequest).toBe(request);
    });

    it('a read-only dependency is sent under readOnlyContext, never under a workspace key', () => {
      const readOnly = new Set(phase.files.filter(f => !f.editable).map(f => f.path));
      for (const data of [
        proposeGenerationData('trim', phase, { prompt: 'In api/app.py return a 404.', workspace: editable, extra: {} }),
        chatGenerationData('trim', phase, { request: 'In api/app.py return a 404.', transcript: [], saved: editable, proposed: editable, selectedPaths: [], extra: {} }),
      ]) {
        for (const key of ['workspace', 'savedWorkspace', 'proposedWorkspace']) {
          expect(Object.keys((data[key] ?? {}) as object).filter(path => readOnly.has(path))).toEqual([]);
        }
        expect(Object.keys(data.readOnlyContext as object).every(path => readOnly.has(path))).toBe(true);
        expect((data.otherEditablePaths as string[]).every(path => !readOnly.has(path))).toBe(true);
      }
    });

    it('a request naming no file sends the whole editable set (propose: the untrimmed bytes, no sentence)', () => {
      const data = proposeGenerationData('trim', phase, { prompt: 'Tighten the wording of the first editable file.', workspace: editable, extra });
      expect(JSON.stringify(data)).toBe(JSON.stringify({ prompt: 'Tighten the wording of the first editable file.', workspace: editable, ...extra }));
      expect(trimSentence('trim', data)).toBe('');
      // A request that names only a read-only file is not narrowed either.
      const context = proposeGenerationData('trim', phase, { prompt: 'Raise the error defined in api/errors.py.', workspace: editable, extra: {} });
      expect(context).toEqual({ prompt: 'Raise the error defined in api/errors.py.', workspace: editable });
    });

    it('a request naming every editable file sends them all, with no path list', () => {
      const data = proposeGenerationData('trim', phaseWith([file('a.py', 'import b\n', true), file('b.py', '', true)]), { prompt: 'edit a.py', workspace: { 'a.py': 'import b\n', 'b.py': '' }, extra: {} });
      expect(data).toEqual({ prompt: 'edit a.py', workspace: { 'a.py': 'import b\n', 'b.py': '' } });
    });
  });

  describe('the matcher and the import scan', () => {
    it('names a file by its path or its unshared file name, as readOnlyTargets does', () => {
      expect(namedFiles(phase, 'fix api/app.py please')).toEqual(['api/app.py']);
      expect(namedFiles(phase, 'fix app.py please')).toEqual(['api/app.py']);
      expect(namedFiles(phase, 'fix the store module')).toEqual([]);
      // readOnlyTargets returns nothing exactly when the message names an editable file.
      for (const message of ['edit api/errors.py and api/app.py', 'edit errors.py', 'fix the list in list.ts', 'edit tests/test_app.py']) {
        const editableNamed = namedFiles(phase, message).some(path => editable[path] !== undefined);
        expect(readOnlyTargets(phase, message).length === 0 || !editableNamed).toBe(true);
        if (editableNamed) expect(readOnlyTargets(phase, message)).toEqual([]);
      }
      // A shared file name names nothing by itself.
      const twins = phaseWith([file('a/index.ts', '', true), file('b/index.ts', '', true)]);
      expect(namedFiles(twins, 'change index.ts')).toEqual([]);
      expect(namedFiles(twins, 'change b/index.ts')).toEqual(['b/index.ts']);
    });

    it('follows Python and JavaScript imports transitively, only within the phase\'s files', () => {
      expect(importClosure(phase, ['api/app.py'], editable)).toEqual(['api/app.py', 'api/store.py', 'api/models.py', 'api/errors.py']);
      expect(importClosure(phase, ['tests/test_app.py'], editable)).toEqual(['api/app.py', 'api/store.py', 'api/models.py', 'api/errors.py', 'tests/test_app.py']);
      expect(importClosure(phase, ['api/unused.py'], editable)).toEqual(['api/unused.py']);
      const cyclic = phaseWith([file('a.py', 'import b\n', true), file('b.py', 'from a import x\n', true)]);
      expect(importClosure(cyclic, ['a.py'], { 'a.py': 'import b\n', 'b.py': 'from a import x\n' })).toEqual(['a.py', 'b.py']);
    });

    it('reads an editable file\'s imports from the bytes being sent, not the pack\'s scaffold', () => {
      const workspace = { ...editable, 'api/unused.py': 'from api import errors\n' };
      expect(importClosure(phase, ['api/unused.py'], workspace)).toEqual(['api/errors.py', 'api/unused.py']);
    });
  });
});
