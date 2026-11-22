import { formatJoinCode, resolveLabOrigin } from './lab';

/**
 * Where a class opens this laptop.
 *
 * The interface list is an argument rather than a read of the machine, so
 * "the link-local address is skipped" is a claim about the code and not about
 * whichever network the laptop running the suite happens to be on.
 */
describe('resolveLabOrigin', () => {
  const INTERFACES = ['127.0.0.1', '169.254.31.7', '192.168.0.10'];

  it('believes an instructor who named the origin themselves', () => {
    expect(resolveLabOrigin({ WEB_ORIGIN: 'https://learn.example.edu' }, INTERFACES)).toEqual({
      hosted: true,
      origin: 'https://learn.example.edu',
      reason: null,
    });
  });

  it('calls a loopback bind what it is, and still gives the local link', () => {
    expect(resolveLabOrigin({}, INTERFACES)).toEqual({
      hosted: false,
      origin: 'http://localhost:3000',
      reason: 'loopback',
    });
  });

  it('skips loopback and link-local addresses when it picks the room address', () => {
    expect(resolveLabOrigin({ API_BIND: '0.0.0.0' }, INTERFACES)).toEqual({
      hosted: true,
      origin: 'http://192.168.0.10:3000',
      reason: null,
    });
  });

  it('says there is no address rather than inventing one', () => {
    expect(resolveLabOrigin({ API_BIND: '0.0.0.0' }, ['127.0.0.1', '169.254.31.7'])).toEqual({
      hosted: true,
      origin: null,
      reason: 'no-address',
    });
  });

  /** The port is the instructor's; the host is this machine's. */
  it('carries the configured port onto the room address', () => {
    expect(
      resolveLabOrigin({ API_BIND: '0.0.0.0', WEB_ORIGIN: 'http://localhost:3100' }, INTERFACES),
    ).toEqual({ hosted: true, origin: 'http://192.168.0.10:3100', reason: null });
  });
});

describe('formatJoinCode', () => {
  it('dashes an eight-character code and leaves anything else alone', () => {
    expect(formatJoinCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(formatJoinCode('SHORT')).toBe('SHORT');
  });
});
