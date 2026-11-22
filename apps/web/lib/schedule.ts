'use client';

/**
 * The class's dates, as the browser prints them.
 *
 * The API stores instants and never a wall time, so every sentence here is
 * formed in the browser's own zone: `schedule.service.ts` forms the same
 * sentences in the machine's zone for the routes that have to refuse in words.
 * Nothing in this file decides anything: a phase a class has not opened is
 * already `status: 'locked'` by the time it reaches the browser
 * (`effectivePhaseStatus`), so the renderers draw the status they are given
 * and choose only the line under it.
 */
import { useEffect, useState } from 'react';
import { DISPLAY_LOCALE } from '@/lib/locale';

/** An instant as a person reads it: "9 September at 09:00". */
export function describeInstant(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = at.toLocaleDateString(DISPLAY_LOCALE, { day: 'numeric', month: 'long' });
  const time = at.toLocaleTimeString(DISPLAY_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} at ${time}`;
}

/** What the card says instead of "pass the gate before it first". */
export function opensLine(opensAt: string): string {
  return `Opens on ${describeInstant(opensAt)}`;
}

/**
 * "Due 16 September at 23:59", and once the date has passed, "Due 16 September
 * at 23:59, 2 days ago". A due date blocks nothing; this is a fact about the
 * work, not a policy about it.
 */
export function dueLine(dueAt: string, now: number): string {
  const at = Date.parse(dueAt);
  const line = `Due ${describeInstant(dueAt)}`;
  if (Number.isNaN(at) || at > now) return line;
  return `${line}, ${agoLabel(now - at)} ago`;
}

/** True once the due date has passed, which is all `text-warn` needs to know. */
export function isPast(iso: string | null, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return !Number.isNaN(at) && at <= now;
}

/** How long, in the largest whole unit: "2 days", "6 hours", "a moment". */
export function agoLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'}`;
  }
  return 'a moment';
}

/** The zone the dates are printed in, named so nobody has to guess. */
export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/* ------------------------- the instructor's inputs ------------------------ */

/**
 * An instant as `<input type="datetime-local">` wants it: a local wall time,
 * `YYYY-MM-DDTHH:mm`, with no zone at all. Built by hand rather than from
 * `toISOString`, which would hand the input UTC and move every date by the
 * offset.
 */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(
    at.getMinutes(),
  )}`;
}

/** The same journey back: a wall time in this zone becomes the instant it is. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/* --------------------------------- clock --------------------------------- */

/**
 * The clock, read after mount and never before.
 *
 * A date rendered on the server is a date the browser disagrees with (a
 * different zone, and a different minute) so everything that compares against
 * now waits for the client. Null means "not yet", which draws nothing.
 */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
