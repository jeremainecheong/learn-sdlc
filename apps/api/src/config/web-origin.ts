/** The web app's origin when WEB_ORIGIN names none: the development server. */
export const DEFAULT_WEB_ORIGIN = 'http://localhost:3000';

/**
 * WEB_ORIGIN is a comma-separated list. Each entry trimmed, in order, empty
 * entries kept: a caller that must not see them filters them itself.
 */
export function webOriginList(raw: string | undefined): string[] {
  return (raw || '').split(',').map((origin) => origin.trim());
}

/** The first entry of WEB_ORIGIN, trimmed; '' when there is none. */
export function firstWebOrigin(raw: string | undefined): string {
  return webOriginList(raw)[0];
}
