import * as fs from 'fs';
import * as path from 'path';
import { CONTRACT_BODIES_DIR, Redactor, leaksIn, shapeOf, type Recording } from './fixtures/contract-bodies/recorder';

/**
 * The contract-bodies recordings are packaged with
 * `apps/api/**`, so none of them may carry an email (`@`), a token (`eyJ`), a
 * 64-hex digest or a uuid; each names the spec that records it; and the
 * redactor keeps equal values equal and different values different.
 */
describe('the contract-bodies recordings', () => {
  const NAMES = ['copy-provenance', 'reset', 'quiz-reveal', 'enrollment'];

  it('holds exactly the four recordings, each naming its recorder spec', () => {
    const files = fs.readdirSync(CONTRACT_BODIES_DIR).filter((one) => one.endsWith('.json')).sort();
    expect(files).toEqual(NAMES.map((one) => `${one}.json`).sort());
    for (const name of NAMES) {
      const recording = JSON.parse(fs.readFileSync(path.join(CONTRACT_BODIES_DIR, `${name}.json`), 'utf-8')) as Recording;
      expect(fs.existsSync(path.resolve(CONTRACT_BODIES_DIR, '..', '..', '..', '..', '..', recording.recordedBy))).toBe(true);
      expect(Object.keys(recording.bodies).length).toBeGreaterThan(0);
    }
  });

  it('carries no @, no eyJ, no 64-hex string and no uuid in any recording', () => {
    for (const name of NAMES) {
      const text = fs.readFileSync(path.join(CONTRACT_BODIES_DIR, `${name}.json`), 'utf-8');
      expect([name, leaksIn(text)]).toEqual([name, []]);
    }
  });

  it('redacts ids, emails, tokens, digests, named values and times, keeping equal values equal', () => {
    const id = '0b5f1c9e-2d4a-4c1b-9e8f-3a2b1c0d9e8f';
    const other = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
    const digest = 'a'.repeat(64);
    const redactor = new Redactor().name('Ixa Pellowmere', 'name:learner').name('ABCD-1234', 'join-code');
    const out = redactor.redact({
      [id]: { id, other, again: id },
      email: 'someone@contract-bodies.test',
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      digest,
      said: 'Ixa Pellowmere joined with ABCD-1234',
      at: ['2026-10-01T03:40:12.000Z', '2026-10-01T03:40:13.000Z', '2026-10-01T03:40:12.000Z'],
    });
    expect(out).toEqual({
      '<uuid:1>': { id: '<uuid:1>', other: '<uuid:2>', again: '<uuid:1>' },
      email: '<email:1>',
      token: '<jwt>',
      digest: '<sha256:1>',
      said: '<name:learner> joined with <join-code>',
      at: ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:01.000Z'],
    });
    expect(leaksIn(JSON.stringify(out))).toEqual([]);
  });

  it('reads a renamed or retyped field as a different shape', () => {
    expect(shapeOf({ a: 1, b: ['x'] })).toEqual(shapeOf({ b: ['y', 'z'], a: 2 }));
    expect(shapeOf({ a: 1 })).not.toEqual(shapeOf({ a: '1' }));
    expect(shapeOf({ projectIsDefault: true })).not.toEqual(shapeOf({ isDefault: true }));
  });
});
