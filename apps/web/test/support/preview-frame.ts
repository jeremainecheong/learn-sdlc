/**
 * The page preview's frame, run in a DOM the way a browser runs it.
 *
 * A test builds the frame's document with `buildPageBundle`, passing
 * {@link sucrase} as the transform and {@link PREVIEW_RUNTIME} as the React
 * runtime the frame inlines, then hands the document to {@link runFrame}. The
 * frame reports through `postMessage`; `runFrame` waits for the message the
 * test names instead of sleeping for a fixed time.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error jsdom ships no type declarations in this workspace
import { JSDOM, VirtualConsole } from 'jsdom';
import { transform } from 'sucrase';
import { vi } from 'vitest';
import { PREVIEW_RUNTIME_PATH, transformOptionsFor } from '@/components/workspace/preview/client/bundle';
import { webPath } from './paths';

/** The transform the frame's builder runs on each file, as the editor runs it. */
export const sucrase = (code: string, file: string): string => transform(code, transformOptionsFor(file)).code;

/** The React runtime asset the frame inlines, read once from `public/`. */
export const PREVIEW_RUNTIME = readFileSync(webPath(join('public', PREVIEW_RUNTIME_PATH)), 'utf8');

/** What the frame posts to its parent. */
export type FrameMessage = { type: string; message?: string; source?: string; nonce?: string };

/** The default wait: the page drew, or it failed. */
export const paintedOrFailed = (m: FrameMessage): boolean => m.type === 'painted' || m.type === 'error';

export type RunningFrame = {
  document: Document;
  /** Every message the frame posted, in order. */
  messages: FrameMessage[];
  /** Script errors the DOM reported outside the frame's own error messages. */
  problems: string[];
  close: () => void;
};

/**
 * Runs a frame document and resolves once a posted message satisfies `until`.
 * Fails if none does within `timeout` milliseconds.
 */
export async function runFrame(
  srcdoc: string,
  { until = paintedOrFailed, timeout = 15_000 }: { until?: (m: FrameMessage) => boolean; timeout?: number } = {},
): Promise<RunningFrame> {
  const messages: FrameMessage[] = [];
  const problems: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => problems.push(e.message));
  const dom = new JSDOM(srcdoc, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window: Window) {
      window.addEventListener('message', (e: MessageEvent) => messages.push(e.data as FrameMessage));
    },
  });
  await vi.waitFor(
    () => {
      if (!messages.some(until)) throw new Error(`the frame posted no awaited message (got: ${messages.map((m) => m.type).join(', ') || 'none'})`);
    },
    { timeout, interval: 20 },
  );
  return { document: dom.window.document as Document, messages, problems, close: () => dom.window.close() };
}
