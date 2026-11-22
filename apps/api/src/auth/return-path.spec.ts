import { RETURN_PATH_MAX_LENGTH, safeReturnPath } from './return-path';

/**
 * The one rule both sign-in doors (Google and the managed identity provider)
 * apply to the page a person is sent back to: a path on this site, or nothing.
 */
describe('safeReturnPath', () => {
  it.each([
    ['/workspace/p1', '/workspace/p1'],
    ['/lessons?phase=design', '/lessons?phase=design'],
    ['/teacher#classes', '/teacher#classes'],
    ['  /workspace/p1  ', '/workspace/p1'],
    ['/', '/'],
    [`/${'a'.repeat(RETURN_PATH_MAX_LENGTH - 1)}`, `/${'a'.repeat(RETURN_PATH_MAX_LENGTH - 1)}`],
  ])('keeps %j', (next, kept) => {
    expect(safeReturnPath(next)).toBe(kept);
  });

  it.each([
    ['an absolute address', 'https://evil.example/steal'],
    ['a protocol-relative address', '//evil.example/steal'],
    ['a leading slash and backslash', '/\\evil.example'],
    ['a backslash later in the path', '/lessons\\..\\evil'],
    ['a tab before a second slash', '/\t/evil.example'],
    ['a newline before a second slash', '/\n/evil.example'],
    ['a carriage return and backslash', '/\r\\evil.example'],
    ['a delete character', '/lessons\u007f'],
    ['a relative path', 'workspace/p1'],
    ['a scheme', 'javascript:alert(1)'],
    ['an empty string', ''],
    ['a path one character too long', `/${'a'.repeat(RETURN_PATH_MAX_LENGTH)}`],
    ['nothing at all', undefined],
    ['a value that is not text', 42],
  ])('refuses %s', (_label, next) => {
    expect(safeReturnPath(next)).toBe('');
  });
});
