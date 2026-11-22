import { qrSvg } from './qr';

/**
 * The picture of a join link. The `qrcode` package ships no
 * decoder, so the assertions are the ones that can be made without one: it is
 * an SVG, it carries nothing executable, two links give two pictures, and the
 * same link gives the same picture every time, which is what makes caching
 * them by their text safe.
 */
describe('qrSvg', () => {
  const LINK = 'http://192.168.0.10:3000/join?code=ABCD-EFGH';

  it('returns a complete SVG element with nothing executable in it', async () => {
    const svg = await qrSvg(LINK);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg.length).toBeGreaterThan(200);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('http://192.168.0.10');
  });

  it('draws a different code for a different link, and the same one twice', async () => {
    const [a, b, again] = await Promise.all([
      qrSvg(LINK),
      qrSvg('http://192.168.0.10:3000/join?code=ZZZZ-YYYY'),
      qrSvg(LINK),
    ]);
    expect(a).not.toEqual(b);
    expect(a).toEqual(again);
  });
});
