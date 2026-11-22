/**
 * Where a room draws its running application.
 *
 * The phase room is 3,600 lines and is mounted only by Playwright, so the one
 * decision inside it that is easy to get wrong (which rooms offer a preview
 * at all) is a pure function tested here instead of a branch nobody can reach.
 *
 * The case it guards: maintenance reports `canPreview: true` and the API starts
 * a preview for it, so the room must draw a control; Testing is in the same
 * position. A room that asked for its key rather than for its capability would
 * give only implementation a surface.
 */
import { describe, expect, it } from 'vitest';
import type { PhaseKey } from '@learnsdlc/shared';
import { previewSurface } from '@/components/workspace/preview/rooms';

const room = (key: PhaseKey, canPreview?: boolean) => ({ key, canPreview });

describe('previewSurface', () => {
  it('gives the implementation room its own preview section', () => {
    expect(previewSurface(room('implementation', true))).toBe('section');
  });

  it('gives testing and maintenance a third working view', () => {
    expect(previewSurface(room('testing', true))).toBe('view');
    expect(previewSurface(room('maintenance', true))).toBe('view');
  });

  it('draws no preview where the pack ships no app to run', () => {
    expect(previewSurface(room('deployment', false))).toBe('none');
    expect(previewSurface(room('requirements', false))).toBe('none');
    expect(previewSurface(room('design', false))).toBe('none');
  });

  /**
   * A phase whose `canPreview` has not been answered yet is not a phase with
   * an app: the room draws nothing rather than a control that cannot work.
   */
  it('draws no preview for a phase that has not said whether it has an app', () => {
    expect(previewSurface(room('implementation'))).toBe('none');
    expect(previewSurface(room('maintenance'))).toBe('none');
  });

  /**
   * `previewUnsupported` is deliberately not an input. A deployment that
   * cannot run an app at all is exactly where the surface has to exist,
   * because the panel's `unavailable` state is where the learner is told why.
   */
  it('draws the surface even where this deployment cannot run an app', () => {
    expect(previewSurface({ key: 'maintenance', canPreview: true, previewUnsupported: 'lambda-runner' } as never)).toBe('view');
    expect(previewSurface({ key: 'implementation', canPreview: true, previewUnsupported: 'lambda-runner' } as never)).toBe('section');
  });
});
