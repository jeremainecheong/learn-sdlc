'use client';

/**
 * The runtime profile line.
 *
 * A deployment runs one profile: what its runner already bakes. A teacher
 * reads which one **before** they upload, and again on the version, in one
 * line that starts "This deployment runs:" and names the three allow-lists.
 * An archive asking for anything else is refused at upload and at publish, so
 * saying it here first is saying the rule before it is met.
 *
 * The lists come from the runtime-profile read where there is one, and from
 * the version's own `supportedStacks` on the editor (the same three lists the
 * draft already carries, so the editor needs no extra request). The profile's
 * name is the contract's (`RUNTIME_PROFILES`), and its digest (the sha256 of
 * the baked allow-lists (python, node, tools), `manifestSha256`) is shown only
 * where the read supplied it.
 */
import { useEffect, useRef, useState } from 'react';
import type { RuntimeProfileView, SupportedStacks } from '@learnsdlc/shared';
import { RUNTIME_PROFILES } from '@learnsdlc/shared';

type Lists = Pick<SupportedStacks, 'python' | 'node' | 'tools'>;

/** "flask, pytest", or "nothing" for an empty list. */
function named(list: readonly string[]): string {
  return list.length === 0 ? 'nothing' : list.join(', ');
}

/** The line itself, from the three allow-lists. */
export function runtimeProfileSentence(lists: Lists): string {
  return `This deployment runs: Python with ${named(lists.python)}; Node with ${named(lists.node)}; and the tools ${named(lists.tools)}.`;
}

/** The profile's name, as the contract has it. */
function runtimeProfileName(profile?: Pick<RuntimeProfileView, 'id' | 'name'> | null): string {
  if (profile?.name) return profile.name;
  return RUNTIME_PROFILES[0]?.name ?? 'Baked runtime';
}

export function RuntimeProfileLine({
  profile,
  stacks,
  testId,
}: {
  /** The runtime-profile read, when one has answered. */
  profile?: RuntimeProfileView | null;
  /** The lists to fall back on: the version's own `supportedStacks`. */
  stacks?: SupportedStacks | null;
  testId?: string;
}) {
  const lists: Lists | null = profile ?? stacks ?? null;
  return (
    <span className="block min-w-0 wrap text-[12.5px] text-ink2" data-testid={testId}>
      {lists ? runtimeProfileSentence(lists) : (RUNTIME_PROFILES[0]?.sentence ?? 'This deployment runs one runtime profile.')}
      {` The profile is the ${runtimeProfileName(profile)}`}
      {profile?.manifestSha256 ? (
        <>
          {', sha256 of the baked allow-lists (python, node, tools) '}
          <span className="mono" title={profile.manifestSha256}>
            {profile.manifestSha256.slice(0, 12)}
          </span>
          {'.'}
        </>
      ) : (
        '.'
      )}
    </span>
  );
}

/** Where a profile read stands: still reading, or done (with the profile, or with null when it failed). */
interface RuntimeProfileRead {
  profile: RuntimeProfileView | null;
  /** False until the read has answered or failed. */
  settled: boolean;
}

/**
 * Read the profile once, for a surface that has no version to read it from,
 * and say whether the read is still going. A failed read is not an error worth
 * a teacher's attention here: the line falls back to the contract's own
 * sentence.
 */
export function useRuntimeProfileRead(read: () => Promise<RuntimeProfileView>): RuntimeProfileRead {
  const [state, setState] = useState<RuntimeProfileRead>({ profile: null, settled: false });
  const reader = useRef(read);
  useEffect(() => {
    let alive = true;
    reader
      .current()
      .then((next) => {
        if (alive) setState({ profile: next ?? null, settled: true });
      })
      .catch(() => {
        if (alive) setState({ profile: null, settled: true });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/**
 * A copy of the runner's allow-lists (`ALLOWED_PYTHON`, `ALLOWED_NODE` and
 * `ALLOWED_TOOLS` in `apps/api/runner/runtime_manifest.py`), used only to hold
 * the line's place while it is read: never drawn visibly, never read by a
 * screen reader. The web cannot import the runner's Python, so
 * `runtime-profile-reserved-lists.test.ts` reads the runner's file and fails
 * when this copy differs from it.
 */
export const RESERVED_LISTS: Lists = {
  python: ['blinker', 'click', 'flask', 'iniconfig', 'itsdangerous', 'jinja2', 'markupsafe', 'packaging', 'pluggy', 'pygments', 'pytest', 'werkzeug'],
  node: ['@testing-library/dom', '@testing-library/react', 'jsdom', 'react', 'react-dom', 'react-router-dom'],
  tools: ['esbuild'],
};

/** What the line says while the profile is read. */
export const RUNTIME_PROFILE_READING = 'Reading the runtime profile this deployment runs.';

/**
 * The line on a surface that reads the profile itself (the upload form), with
 * its place held from the first frame: the place a whole line takes, at
 * any width, is drawn invisibly under it, so the line that arrives a moment
 * after the form opens (or the contract's sentence after a failed read) is
 * drawn in that place and moves nothing below it. While the read is going the
 * line says so.
 */
export function ReservedRuntimeProfileLine({ read, testId }: { read: RuntimeProfileRead; testId?: string }) {
  return (
    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)]" data-testid={testId ? `${testId}-place` : undefined}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 block min-w-0 wrap text-[12.5px]">
        {`${runtimeProfileSentence(RESERVED_LISTS)} The profile is the ${runtimeProfileName(null)}, sha256 of the baked allow-lists (python, node, tools) `}
        <span className="mono">{'0'.repeat(12)}</span>
        {'.'}
      </span>
      <span className="col-start-1 row-start-1 min-w-0">
        {read.settled ? (
          <RuntimeProfileLine profile={read.profile} testId={testId} />
        ) : (
          <span className="block min-w-0 wrap text-[12.5px] text-ink2" data-testid={testId}>
            {RUNTIME_PROFILE_READING}
          </span>
        )}
      </span>
    </span>
  );
}
