'use client';

/**
 * What a refused upload means and how to fix it.
 *
 * Drawn under the fixed refusal sentence, never inside it, so the sentence
 * stays exactly the contract's. The code is read back from that sentence
 * (`refusalCodeOfSentence`), because every coded refusal the page shows is
 * `UPLOAD_REFUSALS[code]` verbatim; anything else (the pace, a session, the
 * server, no answer) has no code and gets `UPLOAD_REFUSAL_FALLBACK`, which
 * never blames the archive. Nothing here reads the archive or the server's text.
 */
import Link from 'next/link';
import type { UploadRefusalCode } from '@learnsdlc/shared';
import {
  TEACHER_GUIDE_PATH,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_CODES,
  UPLOAD_REFUSAL_FALLBACK,
  UPLOAD_REFUSAL_HELP,
} from '@learnsdlc/shared';
import { scrollFocusRef } from '@/lib/scroll-focus';

/** The wire code whose fixed sentence this is, or null. */
export function refusalCodeOfSentence(sentence: string): UploadRefusalCode | null {
  return UPLOAD_REFUSAL_CODES.find((code) => UPLOAD_REFUSALS[code] === sentence) ?? null;
}

export function RefusalExplainer({
  code,
  testId = 'upload-refusal-help',
}: {
  code: UploadRefusalCode | null;
  testId?: string;
}) {
  const help = code === null ? UPLOAD_REFUSAL_FALLBACK : UPLOAD_REFUSAL_HELP[code];
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-ctl border-1.5 border-edge px-3 py-2.5 text-[13px]" data-testid={testId}>
      <p className="m-0 font-semibold text-ink wrap" data-testid={`${testId}-title`}>
        {help.title}
      </p>
      <p className="m-0 text-ink2 wrap" data-testid={`${testId}-fix`}>
        {help.fix}
      </p>
      <Link href={`${TEACHER_GUIDE_PATH}#${help.guideAnchor}`} className="text-[12.5px] underline" data-testid={`${testId}-link`}>
        Read more in the teacher guide
      </Link>
    </div>
  );
}

/** Every refusal, as the guide page's table. */
export function RefusalTable() {
  return (
    <div className="prose-docs min-w-0">
      <table ref={scrollFocusRef}>
        <caption className="sr-only">Every upload refusal, and how to fix it</caption>
        <thead>
          <tr>
            <th scope="col">What happened</th>
            <th scope="col">How to fix it</th>
          </tr>
        </thead>
        <tbody>
          {UPLOAD_REFUSAL_CODES.map((code) => (
            <tr key={code} data-testid={`refusal-row-${code}`}>
              <td>{UPLOAD_REFUSAL_HELP[code].title}</td>
              <td>{UPLOAD_REFUSAL_HELP[code].fix}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
