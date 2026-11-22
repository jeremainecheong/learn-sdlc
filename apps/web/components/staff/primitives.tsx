'use client';

/**
 * The little pieces the three staff pages share: table cell classes, date
 * formatters and a text helper. Everything visual comes from the token layer;
 * nothing here names a colour.
 */

/** Column heading: 12px muted, sentence case, a 1.5px edge2 rule below. */
export const TH =
  'whitespace-nowrap border-b-1.5 border-edge2 px-4 py-2.5 text-left text-[12px] font-medium leading-tight text-muted first:pl-5 last:pr-5';

/** Body cell: 13px ink, padded to line up with TH. */
export const TD = 'px-4 py-3 align-top text-[13px] leading-[1.4] text-ink first:pl-5 last:pr-5';

/** "guided" → "Guided". Identifiers keep their case; this is for plain words. */
export function sentence(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** A moment, or a quiet dash when there is none. Only ever called after mount. */
export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function whenDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

/**
 * How long ago, in the largest whole unit: "3 days", "6 hours", "just now".
 * A queue is read by how long someone has been waiting, and a timestamp makes
 * the reader do that subtraction themselves. Client-only, like `when`.
 */
export function sinceLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'}`;
  }
  return 'just now';
}

/**
 * A moment written the way a person says it: "14:32 today", "09:06 yesterday",
 * then the date once it is older than that. A queue and a list of submissions
 * are read by when, not by which calendar day. Client-only, like `when`.
 */
export function whenShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - at.getTime()) / 86_400_000);
  if (days < 0) return `${time} today`;
  if (days < 1) return `${time} yesterday`;
  return at.toLocaleDateString();
}

/**
 * How long a reason is against the floor it must reach, beside the field: the
 * hint under the field says the rule; this says where the teacher is against
 * it, and turns to the pass colour once it is met. Hidden from assistive
 * technology, which reads the hint and the button's own state instead.
 */
export function ReasonCount({ value, min }: { value: string; min: number }) {
  const n = value.trim().length;
  return (
    <span className={`label-sm tabular-nums ${n >= min ? 'text-pass' : ''}`} data-met={n >= min} aria-hidden="true">
      {reasonCountText(n, min)}
    </span>
  );
}

/**
 * The count's words. "0 of 10 characters" would read as a ceiling of ten; the
 * count says what is still needed until the floor is met, then how long it is.
 */
export function reasonCountText(n: number, min: number): string {
  if (n >= min) return n === 1 ? '1 character' : `${n} characters`;
  const more = min - n;
  if (n === 0) return `${min} characters needed`;
  return more === 1 ? '1 more character needed' : `${more} more characters needed`;
}
