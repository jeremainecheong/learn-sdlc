import { assertNoPrivateData, privacyFindings, redactForStdout } from './privacy';

/* The privacy scan for outputs and the report. */
describe('privacyFindings', () => {
  it('finds emails, uuids, account-like numbers, JWTs, key prefixes, ARNs and hosts', () => {
    const text = [
      'mail someone@example.com',
      'id 123e4567-e89b-12d3-a456-426614174000',
      'acct 123456789012',
      'tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
      'key sk-abcdefghijklmnopqrstu',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/x',
      'AKIAABCDEFGHIJKLMNOP',
    ].join('\n');
    const kinds = privacyFindings(text).map((f) => f.kind).sort();
    expect(kinds).toEqual(expect.arrayContaining(['email', 'uuid', 'aws-account-like', 'jwt', 'key', 'arn']));
  });

  it('does not flag Python decorators or JSON-escaped decorators as emails', () => {
    expect(privacyFindings('@pytest.fixture\ndef client(): pass\n"\\n@bp.get(\'/x\')"')).toEqual([]);
  });

  it('flags extra names supplied at run time, as whole words only', () => {
    expect(privacyFindings('Hello Zed, Zedekiah', [/\bZed\b/]).map((f) => f.kind)).toEqual(['learner-name']);
  });

  it('accepts clean text and the synthetic eval domain is still an email', () => {
    expect(privacyFindings('The learner asked about the overdue rule.')).toEqual([]);
    expect(privacyFindings('eval-1@learnsdlc.test').map((f) => f.kind)).toEqual(['email']);
  });
});

describe('assertNoPrivateData', () => {
  it('throws naming the kind and never the matched text', () => {
    expect(() => assertNoPrivateData('x someone@example.com', 'report.md')).toThrow(/report\.md.*email/);
    try { assertNoPrivateData('x someone@example.com', 'report.md'); } catch (e) {
      expect(String((e as Error).message)).not.toContain('someone@example.com');
    }
  });
});

describe('redactForStdout', () => {
  it('replaces anything private before a line is printed', () => {
    expect(redactForStdout('cost for someone@example.com in 123456789012')).toBe('cost for [email] in [aws-account-like]');
  });
});

describe('no false alarm on numbers: a cost written in a report is not an account id', () => {
  it('does not read twelve digits inside a decimal as an account id', () => {
    expect(privacyFindings('cost 0.000012345678 US$; mean 123456789012.5 ms; 1.234567890123e-7')).toEqual([]);
    expect(() => assertNoPrivateData('| m | 0.000012345678 |', 'scores.csv')).not.toThrow();
  });
  it('still flags a bare twelve-digit number, also at the end of a sentence', () => {
    expect(privacyFindings('account 123456789012.').map((f) => f.kind)).toEqual(['aws-account-like']);
    expect(privacyFindings('id=123456789012,').map((f) => f.kind)).toEqual(['aws-account-like']);
  });
});

describe('no false alarm on digests: every written file is scanned, and records carry sha256 digests', () => {
  const digest = `ab${'123456789012'}cdef${'0'.repeat(10)}${'f'.repeat(36)}`;
  it('does not read twelve digits inside a hex digest as an account id', () => {
    expect(digest).toHaveLength(64);
    expect(privacyFindings(`{"requestSha256": "${digest}", "neutralSha256": "${'9'.repeat(12)}${'e'.repeat(52)}"}`)).toEqual([]);
    expect(redactForStdout(`digest ${digest}`)).toBe(`digest ${digest}`);
  });
  it('still flags twelve digits glued to a word, or beside a short hex-looking token', () => {
    expect(privacyFindings('acct123456789012').map((f) => f.kind)).toEqual(['aws-account-like']);
    expect(privacyFindings('ab123456789012cd').map((f) => f.kind)).toEqual(['aws-account-like']);
  });
});
