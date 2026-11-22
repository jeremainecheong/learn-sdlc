'use client';

/**
 * Under Start here on the Projects
 * page, the starter archives this teacher has downloaded, and when.
 *
 * Read from the rows the download already writes, with the client the
 * teacher portal already uses: `instructorApi.audit()` with no learner (GET
 * /instructor/audit), with no route or column of its own. A starter or shelf
 * download is one `project.sealed-read` row filed against no project
 * (`targetId` null) with the archive's name as its action and no path. A row
 * counts here only when it is
 * also provably the signed-in account's own: the account is both its actor
 * and its subject, as `starterDownload` writes it. That is what keeps the
 * line honest for an admin, whose listing is the whole trail, and for a
 * teacher, whose listing also holds their class's rows.
 *
 * Quiet by design: a learner never sees it and the rows are never asked for;
 * a failed read, or no download, draws nothing, never an error on the
 * library. The listing is newest first and capped at one page, so a download
 * older than the page is simply not mentioned.
 */
import { useEffect, useState } from 'react';
import type { AuditEventView } from '@learnsdlc/shared';
import { whenDate } from '@/components/staff/primitives';
import { instructorApi } from '@/lib/api-instructor';
import { useSession } from '@/lib/session';

/** The archives Start here offers, in the order the card lists them. */
const ARCHIVES = ['starter', 'shelf'] as const;
type ArchiveName = (typeof ARCHIVES)[number];

/** What the line calls each archive (the card's own names for them). */
const ARCHIVE_WORDS: Record<ArchiveName, string> = {
  starter: 'the starter archive',
  shelf: 'the shelf example',
};

/** One page of the trail, the API's own cap (AUDIT_MAX_LIMIT). */
const AUDIT_PAGE = 200;

interface DownloadHistoryLine {
  name: ArchiveName;
  at: string;
  sentence: string;
}

function isArchive(value: unknown): value is ArchiveName {
  return value === 'starter' || value === 'shelf';
}

/**
 * The caller's newest download of each archive, as sentences. A row counts
 * only when it is a starter download (sealed read, no project, no path, a
 * known archive name) and the caller is both its actor and its subject.
 */
export function downloadHistoryLines(rows: readonly AuditEventView[], callerId: string): DownloadHistoryLine[] {
  if (!callerId) return [];
  const newest = new Map<ArchiveName, string>();
  for (const row of rows) {
    if (row.event !== 'project.sealed-read') continue;
    if (row.targetId !== null) continue;
    if (row.detail && row.detail.path !== undefined && row.detail.path !== null) continue;
    if (!isArchive(row.action)) continue;
    if (row.actorUserId !== callerId || row.subjectUserId !== callerId) continue;
    const at = row.createdAt;
    if (!at || Number.isNaN(new Date(at).getTime())) continue;
    const was = newest.get(row.action);
    if (!was || new Date(at).getTime() > new Date(was).getTime()) newest.set(row.action, at);
  }
  return ARCHIVES.filter((name) => newest.has(name)).map((name) => {
    const at = newest.get(name)!;
    return { name, at, sentence: `You downloaded ${ARCHIVE_WORDS[name]} on ${whenDate(at)}.` };
  });
}

export function DownloadHistory() {
  const user = useSession();
  const callerId = user && (user.role === 'INSTRUCTOR' || user.role === 'ADMIN') ? user.id : '';
  const [rows, setRows] = useState<readonly AuditEventView[] | null>(null);

  useEffect(() => {
    setRows(null);
    if (!callerId) return;
    let alive = true;
    // A client that throws at once is a failed read like any other: nothing is drawn.
    Promise.resolve()
      .then(() => instructorApi.audit(undefined, AUDIT_PAGE))
      .then(
        (answer) => {
          if (alive && Array.isArray(answer)) setRows(answer);
        },
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [callerId]);

  const lines = callerId && rows ? downloadHistoryLines(rows, callerId) : [];
  if (lines.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Your starter downloads" data-testid="guide-download-history">
      {lines.map((line) => (
        <li key={line.name} className="purpose wrap" data-testid={`guide-download-history-${line.name}`}>
          {line.sentence}
        </li>
      ))}
    </ul>
  );
}
