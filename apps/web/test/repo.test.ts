/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { repoArchiveName } from '@learnsdlc/shared';
import { saveBlob } from '../lib/download';

/**
 * Two rules the browser owns: the name the archive is saved
 * under, which the API sends in `content-disposition` and the client has to
 * agree with, and the one copy of the object-URL dance.
 */
describe('repoArchiveName', () => {
  it('names the archive after the project', () => {
    expect(repoArchiveName('tasktrackr')).toBe('tasktrackr-repo.zip');
    expect(repoArchiveName('TaskTrackr')).toBe('tasktrackr-repo.zip');
    expect(repoArchiveName('two words')).toBe('two-words-repo.zip');
  });

  it('falls back rather than writing a nameless file', () => {
    expect(repoArchiveName('')).toBe('project-repo.zip');
    expect(repoArchiveName('!!!')).toBe('project-repo.zip');
  });
});

describe('saveBlob', () => {
  it('revokes the object URL a frame later, not immediately', () => {
    const create = vi.fn(() => 'blob:one');
    const revoke = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const globals = globalThis as unknown as {
      URL: { createObjectURL: unknown; revokeObjectURL: unknown };
      requestAnimationFrame: unknown;
    };
    const urls = globals.URL;
    const raf = globals.requestAnimationFrame;
    globals.URL = { ...urls, createObjectURL: create, revokeObjectURL: revoke };
    globals.requestAnimationFrame = (cb: FrameRequestCallback) => {
      frames.push(cb);
      return 1;
    };
    const clicked: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });

    try {
      saveBlob(new Blob(['x']), 'tasktrackr-repo.zip');
      expect(create).toHaveBeenCalledTimes(1);
      expect(clicked).toEqual(['tasktrackr-repo.zip']);
      // Revoking immediately can beat the download in Safari.
      expect(revoke).not.toHaveBeenCalled();
      expect(document.querySelector('a[download]')).toBeNull();
      frames.forEach((frame) => frame(0));
      expect(revoke).toHaveBeenCalledWith('blob:one');
    } finally {
      click.mockRestore();
      globals.URL = urls;
      globals.requestAnimationFrame = raf;
    }
  });
});
