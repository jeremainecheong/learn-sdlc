import { networkInterfaces } from 'os';
import type { LabUnreachable } from '@learnsdlc/shared';
import { firstWebOrigin, isLoopbackAddress, resolveBindAddress } from '../config';
import { JOIN_CODE_LENGTH } from '../instructor/cohorts.service';

/** The default port the web app is served on when nothing says otherwise. */
export const DEFAULT_WEB_PORT = 3000;

/** What the console can say about where this class is reachable from. */
export interface LabOrigin {
  /** True when the API is bound past loopback, so a class on the network can reach it. */
  hosted: boolean;
  /** The origin learners open, without a trailing slash. Null when there is none. */
  origin: string | null;
  /** Why there is nothing for a room to open, when there is nothing. */
  reason: LabUnreachable | null;
}

/**
 * Every IPv4 address this machine has, unfiltered.
 *
 * Injected as an argument to `resolveLabOrigin` rather than read inside it, so
 * the spec can hand it a fixture instead of the build machine's interfaces;
 * a test that asserts "the link-local address is skipped" cannot depend on
 * whether the laptop running it happens to have one.
 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4') out.push(entry.address);
    }
  }
  return out;
}

/** 169.254.0.0/16: an address a machine gave itself because DHCP never answered. */
function isLinkLocal(address: string): boolean {
  return /^169\.254\./.test(address);
}

/** The port of the first entry of WEB_ORIGIN, or 3000. */
function webPortOf(webOrigin: string | undefined): number {
  const first = firstWebOrigin(webOrigin);
  if (!first) return DEFAULT_WEB_PORT;
  try {
    const url = new URL(first);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : DEFAULT_WEB_PORT;
  } catch {
    return DEFAULT_WEB_PORT;
  }
}

/** The host of the first entry of WEB_ORIGIN, or null when it is not a URL. */
function webHostOf(webOrigin: string | undefined): string | null {
  const first = firstWebOrigin(webOrigin);
  if (!first) return null;
  try {
    return new URL(first).hostname;
  } catch {
    return null;
  }
}

/**
 * Where a class opens this laptop, worked out from what it was started with.
 *
 * Read-only by construction: nothing here can turn hosting on, and the API has
 * no route that could. Hosting is `npm run host`, deliberately; a route that
 * could rebind the server would be a way to defeat `assertBindSafety` from
 * inside the app.
 *
 * The order matters. An instructor who set WEB_ORIGIN to a real name has told
 * us the answer and we believe them; a loopback bind is the single-machine
 * demo and still deserves a working local link; a wide bind is a lab and needs
 * an address off this machine's own interfaces.
 */
export function resolveLabOrigin(
  env: NodeJS.ProcessEnv = process.env,
  addresses: string[] = lanAddresses(),
): LabOrigin {
  const webPort = webPortOf(env.WEB_ORIGIN);
  const configuredHost = webHostOf(env.WEB_ORIGIN);

  if (configuredHost && !isLoopbackAddress(configuredHost)) {
    const first = firstWebOrigin(env.WEB_ORIGIN);
    return { hosted: true, origin: first.replace(/\/+$/, ''), reason: null };
  }

  if (isLoopbackAddress(resolveBindAddress(env))) {
    // The single-machine path. The local link still works, and it is the
    // state the Playwright suite runs in.
    return { hosted: false, origin: `http://localhost:${webPort}`, reason: 'loopback' };
  }

  const lan = addresses.find((a) => !isLoopbackAddress(a) && !isLinkLocal(a));
  if (!lan) return { hosted: true, origin: null, reason: 'no-address' };
  return { hosted: true, origin: `http://${lan}:${webPort}`, reason: null };
}

/** ABCD-EFGH reads off a slide; ABCDEFGH does not. The API strips the dash back out. */
export function formatJoinCode(code: string): string {
  const half = JOIN_CODE_LENGTH / 2;
  return code.length === JOIN_CODE_LENGTH ? `${code.slice(0, half)}-${code.slice(half)}` : code;
}
