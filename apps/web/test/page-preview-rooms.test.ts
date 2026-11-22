/**
 * Every room with page code gets a preview.
 *
 * The reference project keeps its sandbox preview. An
 * uploaded project, which has no sandbox preview, gets the page preview
 * wherever its visible files hold a page to draw. A room with no page code
 * (requirements, design, a deploy-only room) still draws nothing.
 */
import { describe, expect, it } from 'vitest';
import type { PhaseKey } from '@learnsdlc/shared';
import { previewMode, previewOffered, previewSurface } from '@/components/workspace/preview/rooms';

const UPLOADED = { application: null };
const REFERENCE = { application: 'TaskTrackr' };
const files = (...paths: string[]) => paths.map((path) => ({ path, content: '', editable: true, language: 'typescript' }));

const STARTER_IMPLEMENTATION = files('api/main.py', 'api/shelf.py', 'web/src/lib/shelf.ts', 'web/src/lib/shelf.test.ts', 'web/src/ShelfPage.ts', 'web/src/main.ts');
const STARTER_TESTING = files('api/shelf.py', 'web/src/lib/shelf.ts', 'web/src/lib/acceptance.test.ts');
const STARTER_MAINTENANCE = files('api/shelf.py', 'web/src/lib/shelf.ts', 'web/src/lib/shelf.test.ts', 'web/src/ShelfPage.ts');
const TASKTRACKR_IMPLEMENTATION = files('web/index.html', 'web/src/main.tsx', 'web/src/router.tsx', 'web/src/lib/overdue.ts');

const uploaded = (key: PhaseKey, f: ReturnType<typeof files>) => ({ key, canPreview: false, provenance: UPLOADED, files: f, previewUnsupported: null });

describe('rooms', () => {
  it('gives an uploaded implementation room a page preview section', () => {
    const room = uploaded('implementation', STARTER_IMPLEMENTATION);
    expect(previewOffered(room)).toBe(false);
    expect(previewMode(room)).toBe('client');
    expect(previewSurface(room)).toBe('section');
  });

  it('gives an uploaded maintenance room a page preview view (its page component)', () => {
    const room = uploaded('maintenance', STARTER_MAINTENANCE);
    expect(previewMode(room)).toBe('client');
    expect(previewSurface(room)).toBe('view');
  });

  it('draws nothing in a room with no page to draw', () => {
    expect(previewSurface(uploaded('requirements', files('requirements/story.json')))).toBe('none');
    expect(previewSurface(uploaded('design', files('design/my-design.md')))).toBe('none');
    expect(previewSurface(uploaded('deployment', files('deploy/shelf.json')))).toBe('none');
    // A library and its tests are not a page.
    expect(previewSurface(uploaded('testing', STARTER_TESTING))).toBe('none');
    // A server script under web/ is not a page either.
    expect(previewSurface(uploaded('deployment', files('web/serve.js')))).toBe('none');
  });

  it('keeps the reference project on its sandbox preview, unchanged', () => {
    const room = { key: 'implementation' as const, canPreview: true, provenance: REFERENCE, files: TASKTRACKR_IMPLEMENTATION, previewUnsupported: null };
    expect(previewMode(room)).toBe('server');
    expect(previewSurface(room)).toBe('section');
    expect(previewSurface({ key: 'requirements' as const, canPreview: false, provenance: REFERENCE, files: files('requirements/story.json') })).toBe('none');
  });

  it('stands the page preview in for the reference project where the sandbox preview cannot run', () => {
    for (const why of ['disabled', 'lambda-runner', 'isolation'] as const) {
      const room = { key: 'implementation' as const, canPreview: true, provenance: REFERENCE, files: TASKTRACKR_IMPLEMENTATION, previewUnsupported: why };
      expect(previewMode(room)).toBe('client');
      expect(previewSurface(room)).toBe('section');
    }
  });

  it('keeps the server preview and the section surface for a phase whose files are not known', () => {
    expect(previewMode({ key: 'implementation', canPreview: true, previewUnsupported: 'lambda-runner' } as never)).toBe('server');
    expect(previewSurface({ key: 'implementation', canPreview: true, previewUnsupported: 'lambda-runner' } as never)).toBe('section');
  });
});
