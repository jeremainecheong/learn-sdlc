import { UPLOAD_REFUSALS, UPLOAD_REFUSAL_DETAIL_MAX } from '@learnsdlc/shared';
import { checkRuntimeProfile, type PackRefusal, type RawPackManifest } from './upload-limits';
import { uploadRefused, type UploadRefusalBody } from './upload.service';

/**
 * A runtime outside the baked profile names the package.
 *
 * `checkRuntimeProfile` (upload-limits.ts) builds one sentence per package it
 * refuses ("project.runtime asks for <package>, which is outside the runtime
 * this deployment bakes. ..."). `RUNTIME_OUTSIDE_PROFILE` carries that
 * sentence in `detail`, so the page can say which library, not only "This
 * project asks for a library this deployment does not bake". The detail is
 * shaped as `NOT_A_PACK`'s is (printable, one full stop, at most
 * `UPLOAD_REFUSAL_DETAIL_MAX` characters). `sentence` and `message` stay the
 * fixed `UPLOAD_REFUSALS[code]`, and every other code carries no detail.
 */
const manifest = (runtime: unknown): RawPackManifest =>
  ({ project: { slug: 'books', title: 'Books', runtime }, phases: [] }) as unknown as RawPackManifest;

const bodyOf = (reasons: PackRefusal[]): UploadRefusalBody => uploadRefused(reasons).getResponse() as UploadRefusalBody;

describe('RUNTIME_OUTSIDE_PROFILE carries the per-package sentence in detail', () => {
  it('names the first refused package, under the fixed sentence', () => {
    const reasons = checkRuntimeProfile(manifest({ python: { packages: ['requests==2.32.3'] } }), () => [
      { code: 'RUNTIME_OUTSIDE_PROFILE', package: 'requests==2.32.3', ecosystem: 'python', reason: 'not-in-profile' } as never,
      { code: 'RUNTIME_OUTSIDE_PROFILE', package: 'numpy==2.1.0', ecosystem: 'python', reason: 'not-in-profile' } as never,
    ]);
    const body = bodyOf(reasons);
    expect(body.code).toBe('RUNTIME_OUTSIDE_PROFILE');
    expect(body.sentence).toBe(UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE);
    expect(body.message).toBe(UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE);
    expect(body.findings).toEqual([]);
    expect(body.detail).toBe(
      'project.runtime asks for requests==2.32.3, which is outside the runtime this deployment bakes. Use only the packages the runtime profile lists, and upload again.',
    );
    // the package is named in detail only, never in the fixed sentence
    expect(body.sentence).not.toContain('requests');
  });

  it('a runtime block that cannot be read says so in detail, naming nothing', () => {
    const body = bodyOf(
      checkRuntimeProfile(manifest({ python: 'x' }), () => {
        throw new Error('unreadable');
      }),
    );
    expect(body.code).toBe('RUNTIME_OUTSIDE_PROFILE');
    expect(body.detail).toBe(
      'project.runtime could not be read as a runtime this deployment runs. Name only the packages this deployment bakes, pinned exactly, and upload again.',
    );
  });

  it('is printable, ends with one full stop and fits UPLOAD_REFUSAL_DETAIL_MAX, as NOT_A_PACK detail does', () => {
    const body = bodyOf([{ code: 'RUNTIME_OUTSIDE_PROFILE', where: 'project.runtime', sentence: `project.runtime asks for \u0007${'p'.repeat(600)}.` }]);
    expect(body.detail!.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
    expect(body.detail).toMatch(/^project\.runtime asks for p+\.$/);
    expect(body.detail).not.toMatch(/[\u0000-\u001f]/);
  });

  it('an empty sentence leaves the key out', () => {
    expect('detail' in bodyOf([{ code: 'RUNTIME_OUTSIDE_PROFILE', where: 'project.runtime', sentence: ' ' }])).toBe(false);
  });

  it('every other code that is not NOT_A_PACK still carries no detail', () => {
    for (const code of ['PACK_SECRET_FILE', 'PACK_EXECUTABLE_SPLIT', 'PACK_WARMUP_NOT_UPLOADABLE', 'PACK_OVER_BUDGET', 'PACK_SEALED_BYTES', 'UPLOAD_TITLE_INVALID', 'ARCHIVE_PATH_ESCAPE']) {
      const body = bodyOf([{ code, where: 'files', sentence: 'files: something the door said about it.' }]);
      expect({ code, wire: body.code, detail: 'detail' in body }).toEqual({ code, wire: body.code, detail: false });
    }
  });
});
