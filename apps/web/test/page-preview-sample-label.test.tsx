// @vitest-environment jsdom
/**
 * A Page preview "with sample data" that draws "No lists
 * yet." (the finished TaskTrackr project's Testing and Maintenance rooms).
 *
 * The frame answers the page's API calls from `preview/sample-data.json` when
 * the project ships one and with nothing otherwise; TaskTrackr ships none and
 * its pages fetch their lists, so they draw empty under a line that promised
 * sample data. A page that asks the API, in a project with no sample data,
 * reads "Page preview: your code running in the browser. Your API is not
 * running here, so the page gets no data from it." Every other page reads the
 * sample-data line, word for word: the Deadline badge page holds its own three
 * tasks and calls nothing.
 */
import { repoPath } from './support/paths';
import { deadlineBadgeLearnerWork, deadlineBadgePhases, deadlineBadgeRoom } from './support/deadline-badge-pack';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientPagePreview } from '@/components/workspace/preview/client/ClientPagePreview';
import { PagePreviewTab } from '@/components/workspace/preview/client/PagePreviewTab';
import { pagePreviewLabel } from '@/components/workspace/preview/client/bundle';
import { PAGE_PREVIEW_LABEL, PAGE_PREVIEW_LABEL_NO_DATA } from '@/components/workspace/preview/copy';

const WEB = repoPath('content/tasktrackr/phases/04-testing/readonly/web/src');
/** The finished project's Testing room: its page code, whose API client fetches the lists. */
const TASKTRACKR = {
  'web/src/main.tsx': readFileSync(path.join(WEB, 'main.tsx'), 'utf8'),
  'web/src/api/client.ts': readFileSync(path.join(WEB, 'api/client.ts'), 'utf8'),
  'api/routes/tasks.py': '@bp.get("/api/tasks")\ndef list_tasks(): ...\n',
};
/** The Deadline badge page in miniature: its tasks are in its own code, and it calls nothing. */
const DEADLINE_BADGE = {
  'web/index.html': '<div id="root"></div><script type="module" src="./src/main.ts"></script>',
  'web/src/main.ts': "const tasks = [{ title: 'Yesterday', dueDate: '2026-11-12', done: false }];\ndocument.getElementById('root')!.textContent = tasks[0].title;\n",
  'web/src/lib/overdue.ts': 'export function isOverdue() { return false; }\n',
  'web/src/lib/overdue.test.ts': "test('x', () => fetch('/api/never'));\n",
};
/** The real Deadline badge page: the tracked pack's rooms that hold a page, read from the pack itself. */
const PAGE_ROOMS = deadlineBadgePhases().filter((phase) => 'web/index.html' in deadlineBadgeRoom(phase));

const NEVER = () => new Promise<never>(() => {});
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('the page preview says what the frame can give the page', () => {
  it('the words', () => {
    expect(PAGE_PREVIEW_LABEL_NO_DATA).toBe('Page preview: your code running in the browser. Your API is not running here, so the page gets no data from it.');
    expect(PAGE_PREVIEW_LABEL).toBe('Page preview: your code running in the browser with sample data. Your API is not running here.');
  });

  it('a page that fetches, in a project with no sample data: no promise of sample data', () => {
    expect(pagePreviewLabel(TASKTRACKR)).toBe(PAGE_PREVIEW_LABEL_NO_DATA);
  });

  it('the same page in a project that ships sample data keeps the line', () => {
    expect(pagePreviewLabel({ ...TASKTRACKR, 'web/preview/sample-data.json': '{"/api/lists": []}' })).toBe(PAGE_PREVIEW_LABEL);
  });

  it('a page that holds its own data (the demo\'s Deadline badge) keeps the line, a fetch in a test or the API not counted', () => {
    expect(pagePreviewLabel(DEADLINE_BADGE)).toBe(PAGE_PREVIEW_LABEL);
    expect(pagePreviewLabel({ ...DEADLINE_BADGE, 'api/app.py': 'requests.get("/api/x"); fetch(x)' })).toBe(PAGE_PREVIEW_LABEL);
    expect(pagePreviewLabel({})).toBe(PAGE_PREVIEW_LABEL);
  });

  /*
   * A real uploaded page, not a miniature of it: the tracked pack's files for the three rooms that offer the Page
   * preview (Implementation, Testing, Maintenance), as the learner's workspace holds them, and finished learner work.
   */
  describe('the Deadline badge page keeps its sample-data line', () => {
    const PAGE_PREVIEW_SAMPLE_LINE = 'Page preview: your code running in the browser with sample data. Your API is not running here.';

    it('the pack\'s page is in three rooms, each with its index.html and main.ts', () => {
      expect(PAGE_ROOMS).toEqual(['03-implementation', '04-testing', '06-maintenance']);
      for (const room of PAGE_ROOMS) {
        expect(deadlineBadgeRoom(room)['web/index.html'], room).toContain('src/main.ts');
        expect(deadlineBadgeRoom(room)['web/src/main.ts'], room).toContain("import { isOverdue } from './lib/overdue';");
      }
    });

    it.each(PAGE_ROOMS)(
      '%s: as the room opens, and with the learner\'s work in it, the line is the sample-data line, word for word',
      (room) => {
        expect(pagePreviewLabel(deadlineBadgeRoom(room))).toBe(PAGE_PREVIEW_SAMPLE_LINE);
        expect(pagePreviewLabel({ ...deadlineBadgeRoom(room), ...deadlineBadgeLearnerWork(room) })).toBe(PAGE_PREVIEW_SAMPLE_LINE);
      },
    );

    it('the panel and the tab draw that line over the pack\'s Implementation page', async () => {
      const files = { ...deadlineBadgeRoom('03-implementation'), ...deadlineBadgeLearnerWork('03-implementation') };
      await act(async () => root.render(<ClientPagePreview files={files} loadTransform={NEVER} loadRuntime={NEVER} />));
      expect(q('page-preview-label')!.textContent).toBe(PAGE_PREVIEW_SAMPLE_LINE);
      await act(async () => root.render(<PagePreviewTab record={{ files, takenAt: '2026-11-18T01:00:00.000Z', version: 1 } as never} loadTransform={NEVER} loadRuntime={NEVER} />));
      expect(q('page-preview-tab-label')!.textContent).toBe(PAGE_PREVIEW_SAMPLE_LINE);
    });

    it('the check can fail: the same page with a fetch in it would lose the line', () => {
      const files = deadlineBadgeRoom('03-implementation');
      expect(pagePreviewLabel({ ...files, 'web/src/main.ts': `${files['web/src/main.ts']}\nvoid fetch('/api/tasks');\n` })).toBe(PAGE_PREVIEW_LABEL_NO_DATA);
    });
  });

  it('the workspace\'s panel and the tab of its own draw the chosen line', async () => {
    await act(async () => root.render(<ClientPagePreview files={TASKTRACKR} loadTransform={NEVER} loadRuntime={NEVER} />));
    expect(q('page-preview-label')!.textContent).toBe(PAGE_PREVIEW_LABEL_NO_DATA);
    await act(async () => root.render(<ClientPagePreview files={DEADLINE_BADGE} loadTransform={NEVER} loadRuntime={NEVER} />));
    // a new `files` reaches the label with the snapshot the frame draws, after the typing pause; a fresh mount reads it at once
    act(() => root.unmount()); root = createRoot(host);
    await act(async () => root.render(<ClientPagePreview files={DEADLINE_BADGE} loadTransform={NEVER} loadRuntime={NEVER} />));
    expect(q('page-preview-label')!.textContent).toBe(PAGE_PREVIEW_LABEL);
    await act(async () => root.render(<PagePreviewTab record={{ files: TASKTRACKR, takenAt: '2026-11-18T01:00:00.000Z', version: 1 } as never} loadTransform={NEVER} loadRuntime={NEVER} />));
    expect(q('page-preview-tab-label')!.textContent).toBe(PAGE_PREVIEW_LABEL_NO_DATA);
    await act(async () => root.render(<PagePreviewTab record={{ files: DEADLINE_BADGE, takenAt: '2026-11-18T01:00:00.000Z', version: 1 } as never} loadTransform={NEVER} loadRuntime={NEVER} />));
    expect(q('page-preview-tab-label')!.textContent).toBe(PAGE_PREVIEW_LABEL);
    await act(async () => root.render(<PagePreviewTab record={null} loadTransform={NEVER} loadRuntime={NEVER} />));
    expect(q('page-preview-tab-label')!.textContent).toBe(PAGE_PREVIEW_LABEL);
  });
});
