import QRCode from 'qrcode';

/**
 * A join link as an SVG element, sized by CSS at the call site.
 *
 * Error correction M because a projected code is read across a room with
 * somebody's head in front of it, and margin 1 because the SVG sits inside a
 * card that already has padding.
 *
 * The returned string is a complete `<svg>` with no script and no external
 * reference, and the web renders it with `dangerouslySetInnerHTML`. That is
 * safe here and only here: the input is an origin this API composed from its
 * own configuration plus a join code the API itself generated. Never pass
 * learner text through this function.
 */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}
