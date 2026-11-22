import * as fs from 'fs';
import * as path from 'path';
import { HIDDEN_TEST_NAME, isHiddenTestName, storableText, strictText } from './door-rules';

/**
 * The two rules every door shares, as a leaf.
 *
 * - `isHiddenTestName`: the one hidden-test-name rule. The upload's
 *   HIDDEN_NOT_FILE, the sealed-role door and `draft.ts` ask this one function, so
 *   a draft can never hold a hidden name that publish refuses. There are no
 *   hidden helper files.
 * - `strictText`: the upload door's text rule and the sealed-role door's rule
 *   (fatal UTF-8 and no U+0000) as one helper.
 */

describe('door-rules', () => {
  it('imports nothing from the app: a leaf, so no door can make a cycle through it', () => {
    const text = fs.readFileSync(path.join(__dirname, 'door-rules.ts'), 'utf8');
    const imports = text.split('\n').filter((line) => /^\s*import\b|require\(/.test(line));
    expect(imports).toEqual([]);
  });

  describe('isHiddenTestName: exactly the run-shape rule’s (test_*.py, *.test.ts, *.test.tsx), by basename', () => {
    it('helpers and other test spellings are refused; the rule’s two spellings are accepted', () => {
      const refused = ['extra_test.py', 'helpers.py', 'web/src/lib/extra.spec.ts'];
      const accepted = ['test_extra.py', 'a/b.test.tsx'];
      expect(refused.map((one) => [one, isHiddenTestName(one)])).toEqual(refused.map((one) => [one, false]));
      expect(accepted.map((one) => [one, isHiddenTestName(one)])).toEqual(accepted.map((one) => [one, true]));
    });

    it('the rest of the run-shape rule’s cases', () => {
      const yes = [
        'hidden/test_tasks.py',
        'test_a.py',
        'hidden_tests/api/test_shelf_hidden.py',
        'web/src/App.test.ts',
        'x.test.tsx',
        'deep/a/b/c/test_A9_z.py',
      ];
      const no = [
        'conftest.py',
        'test_.py', // `test_` then at least one name character
        'test-a.py',
        'test_a.pyc',
        'test_a.py.txt',
        'grade.sh',
        'a.test.js',
        'a.test.jsx',
        'a.spec.tsx',
        'test_a.ts',
        'mytest_a.py', // basename must start with test_
        'x.test.ts/inner.py',
        '',
      ];
      expect(yes.filter((one) => !isHiddenTestName(one))).toEqual([]);
      expect(no.filter((one) => isHiddenTestName(one))).toEqual([]);
    });

    it('with a run’s language, only that language’s spelling (the run-shape rule pairs the two)', () => {
      expect(isHiddenTestName('hidden/test_a.py', 'python')).toBe(true);
      expect(isHiddenTestName('hidden/a.test.ts', 'python')).toBe(false);
      expect(isHiddenTestName('hidden/a.test.tsx', 'typescript')).toBe(true);
      expect(isHiddenTestName('hidden/test_a.py', 'typescript')).toBe(false);
      expect(isHiddenTestName('hidden/test_a.py', 'ruby')).toBe(false);
      expect(isHiddenTestName('hidden/test_a.py', undefined)).toBe(true);
    });

    it('a run language that names an Object.prototype member is no language (false, never a TypeError)', () => {
      for (const language of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
        expect([language, isHiddenTestName('hidden/test_a.py', language)]).toEqual([language, false]);
        expect([language, isHiddenTestName('hidden/a.test.ts', language)]).toEqual([language, false]);
      }
    });

    it('HIDDEN_TEST_NAME is the same rule as a RegExp (no global flag, so .test is stateless)', () => {
      expect(HIDDEN_TEST_NAME).toBeInstanceOf(RegExp);
      expect(HIDDEN_TEST_NAME.global).toBe(false);
      expect(HIDDEN_TEST_NAME.sticky).toBe(false);
      for (const one of ['a/test_x.py', 'x.test.ts', 'x.test.tsx', 'helpers.py', 'extra_test.py']) {
        expect([one, HIDDEN_TEST_NAME.test(one)]).toEqual([one, isHiddenTestName(one)]);
        expect([one, HIDDEN_TEST_NAME.test(one)]).toEqual([one, isHiddenTestName(one)]);
      }
    });
  });

  describe('storableText: a string a door parsed (a JSON escape) that PostgreSQL text could not hold, or would store mangled', () => {
    it('U+0000 is nul; a lone high or low surrogate is surrogate; a well-formed pair, U+FFFD written on purpose and other control characters are storable', () => {
      expect(storableText('Lend the book.\u0000')).toBe('nul');
      expect(storableText('\u0000')).toBe('nul');
      expect(storableText('intro \ud800')).toBe('surrogate');
      expect(storableText('\udc00 then text')).toBe('surrogate');
      expect(storableText('\ude00\ud83d')).toBe('surrogate');
      expect(storableText('a pair \ud83d\ude00 is one letter')).toBeNull();
      expect(storableText('U+FFFD on purpose: \ufffd')).toBeNull();
      expect(storableText('tab\tand\nnewline\u0007')).toBeNull();
      expect(storableText('')).toBeNull();
    });
  });

  describe('strictText: fatal UTF-8, and no U+0000', () => {
    it('plain UTF-8 text (with a BOM, multi-byte letters and a U+FFFD written on purpose) is text', () => {
      const plain = Buffer.from('User-agent: *\nDisallow:\n', 'utf8');
      expect(strictText(plain)).toEqual({ ok: true, text: 'User-agent: *\nDisallow:\n' });
      const letters = Buffer.from('Café — 書架 \u{1F4DA} �\n', 'utf8');
      expect(strictText(letters)).toEqual({ ok: true, text: 'Café — 書架 \u{1F4DA} �\n' });
      expect(strictText(new Uint8Array(0))).toEqual({ ok: true, text: '' });
      expect(strictText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toMatchObject({ ok: true });
    });

    it('a NUL anywhere is refused as nul, even in otherwise valid UTF-8', () => {
      expect(strictText(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0x68, 4, 0, 0]))).toEqual({ ok: false, why: 'nul' });
      expect(strictText(Buffer.from('a\u0000b', 'utf8'))).toEqual({ ok: false, why: 'nul' });
    });

    it('bytes that are not UTF-8 (a PNG signature, a lone continuation byte, an overlong form, a surrogate) are refused as not-utf8', () => {
      const cases: Record<string, number[]> = {
        'a PNG signature': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41],
        'a lone continuation byte': [0x61, 0x80, 0x62],
        'an overlong slash': [0xc0, 0xaf],
        'an encoded surrogate': [0xed, 0xa0, 0x80],
        'a cut-off sequence': [0x61, 0xe6, 0x9b],
        'latin-1 é': [0x63, 0x61, 0x66, 0xe9],
      };
      for (const [name, bytes] of Object.entries(cases)) {
        expect([name, strictText(Uint8Array.from(bytes))]).toEqual([name, { ok: false, why: 'not-utf8' }]);
      }
    });

    it('a refusal never carries the bytes or any text of them', () => {
      const said = strictText(Buffer.from('QZXPLANTED\u0000', 'utf8'));
      expect(JSON.stringify(said)).not.toContain('QZX');
      expect(Object.keys(said).sort()).toEqual(['ok', 'why']);
    });
  });
});
