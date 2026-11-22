/**
 * RESERVED_NAME tells the truth.
 *
 * No upload is ever refused for its name. The address an uploaded project gets
 * is minted from its title by `mintTeacherSlug` (apps/api/src/content/
 * importer.service.ts), which adds `-2`, `-3` to an address that is taken or
 * kept for the platform, and the upload goes ahead. `RESERVED_NAME` stays one
 * of the 29 wire codes, so its sentence and its
 * help entry must say what happens rather than describe a refusal that does
 * not: the in-app refusal table draws them.
 *
 * The guard below keeps that true: if an API source ever names RESERVED_NAME
 * (a route that sends it), this wording would be wrong and the test fails.
 */
import { repoPath } from './support/paths';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPLOAD_REFUSALS, UPLOAD_REFUSAL_CODES, UPLOAD_REFUSAL_HELP } from '@learnsdlc/shared';

const API_SRC = repoPath('apps/api/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

describe('a taken or reserved address gets a number, and the upload goes ahead', () => {
  it('no API source sends RESERVED_NAME, so no upload is refused for its name', () => {
    const naming = sources(API_SRC).filter((file) => readFileSync(file, 'utf8').includes('RESERVED_NAME'));
    expect(naming).toEqual([]);
    // The code itself stays a wire code: 29 codes.
    expect(UPLOAD_REFUSAL_CODES).toHaveLength(29);
    expect(UPLOAD_REFUSAL_CODES).toContain('RESERVED_NAME');
  });

  it("the page's sentence says a number is added and the upload goes ahead, and asks for no new title", () => {
    const sentence = UPLOAD_REFUSALS.RESERVED_NAME;
    expect(sentence).toMatch(/taken or kept for the platform/);
    expect(sentence).toMatch(/a number is added/);
    expect(sentence).toMatch(/the upload goes ahead/);
    expect(sentence).not.toMatch(/Choose another title|already in use|refused|nothing was imported/i);
  });

  it('the help title and fix say the same, and ask the teacher to change nothing', () => {
    const help = UPLOAD_REFUSAL_HELP.RESERVED_NAME;
    expect(help.title).toMatch(/number/);
    expect(help.fix).toMatch(/the upload goes ahead/);
    expect(`${help.title} ${help.fix}`).not.toMatch(/Choose another title|reserved or taken|refused/i);
    expect(help.guideAnchor).toBe('2-upload');
  });
});
