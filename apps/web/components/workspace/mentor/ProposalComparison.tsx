'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, describeError } from '@/lib/api';
import { getSession, useSession } from '@/lib/session';
import { fileDiff, type FileDiff } from '@/components/pr/diff';
import { Button, Notice } from '@/components/ui';
import { analyseChange, narrowRequestSentence, proposalChurn, type ChangeAnalysis } from './proposalChange';
import { ProposalChangeSummary } from './ProposalChangeSummary';

/**
 * One file's measurement, kept only as long as its two copies are the bytes it
 * was measured from. Unchanged files carry no measurement at all: nothing on
 * screen reads either number for them.
 */
type ComparedFile =
  | { path: string; original: string | undefined; content: string; changed: true; diff: FileDiff; analysis: ChangeAnalysis }
  | { path: string; original: string | undefined; content: string; changed: false; diff: null; analysis: null };

/**
 * An explicitly loaded saved copy, never a claim about the proposal's original base.
 *
 * `request` is the learner's own words for the turn that produced this
 * proposal, when the caller can establish them. It is optional because the
 * stored prompt on the chat path is a JSON context envelope rather than a
 * request, and quoting that back would attribute words to this request that the
 * learner may never have written for it.
 */
export function ProposalComparison({ phaseId, files, onInspect, request }: { phaseId: string; files: Record<string, string>; onInspect?: () => void; request?: string | null }) {
  const session = useSession();
  const owner = `${session?.id ?? 'signed-out'}:${phaseId}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const alive = useRef(true);
  const inFlight = useRef(false);
  const [saved, setSaved] = useState<{ owner: string; files: Record<string, string> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function compare() {
    if (inFlight.current) return;
    onInspect?.();
    const expectedOwner = owner;
    const current = () => alive.current && ownerRef.current === expectedOwner && `${getSession()?.id ?? 'signed-out'}:${phaseId}` === expectedOwner;
    inFlight.current = true; setLoading(true); setError('');
    try {
      // The workspace wrapper may reconcile unsaved drafts. This GET must stay read-only.
      const detail = await api.phase(phaseId);
      if (!current()) return;
      if (detail.id !== phaseId) throw new Error('The saved files belong to a different phase.');
      setSaved({ owner: expectedOwner, files: Object.fromEntries(detail.files.filter(file => file.editable).map(file => [file.path, file.content])) });
    } catch (err) {
      if (current()) setError(describeError(err, 'Saved files could not be loaded. Your proposal is kept.'));
    } finally {
      inFlight.current = false;
      if (current()) setLoading(false);
    }
  }
  const baseline = saved?.owner === owner ? saved.files : null;
  // The learner's own words for this request do not change while they type, so
  // they are read once rather than on every render of a flagged comparison.
  const asked = useMemo(() => narrowRequestSentence(request), [request]);
  // Only an opened comparison measures anything: before the click there is no
  // baseline and no per-file work at all. After it, the panel around this
  // component re-renders on every keystroke in the mentor composer and in every
  // proposed-file textarea, handing down `files={{ ...proposal.files, ...edits }}`:
  // a fresh object holding the same strings. So the bytes are the identity: a
  // file whose two copies are the pair already measured keeps its result, and a
  // file whose copies are identical is never diffed or walked at all, because
  // nothing on screen reads a number for it.
  //
  // The cache is read while rendering and written only once the render has been
  // committed. A render React throws away therefore leaves nothing behind: it
  // can cost the measurement again, which is the same work this render already
  // did, but it can never hand a later render a result from a pass that never
  // reached the screen.
  const measured = useRef(new Map<string, ComparedFile>());
  const compared: ComparedFile[] = useMemo(() => {
    if (!baseline) return [];
    const rows: ComparedFile[] = [];
    for (const [path, content] of Object.entries(files)) {
      const original = baseline[path];
      const kept = measured.current.get(path);
      if (kept && kept.original === original && kept.content === content) { rows.push(kept); continue; }
      if (original === content) { rows.push({ path, original, content, changed: false, diff: null, analysis: null }); continue; }
      const diff = fileDiff(path, original, content);
      rows.push({ path, original, content, changed: true, diff, analysis: analyseChange(path, original, content, diff) });
    }
    return rows;
  }, [baseline, files]);
  useEffect(() => {
    if (baseline) measured.current = new Map(compared.map(file => [file.path, file]));
  }, [baseline, compared]);
  const rollup = proposalChurn(compared.flatMap(file => (file.analysis ? [file.analysis] : [])));
  const counted = rollup.meaning === 0
    ? rollup.kind === 'json-fields' ? 'no JSON field differs' : rollup.kind === 'word-occurrences' ? 'no word differs' : 'nothing measured differs'
    : rollup.kind === 'json-fields' ? `only ${rollup.meaning === 1 ? '1 field differs' : `${rollup.meaning} fields differ`}`
      : rollup.kind === 'word-occurrences' ? `only ${rollup.meaning === 1 ? '1 word occurrence differs' : `${rollup.meaning} word occurrences differ`}`
        : `only ${rollup.meaning === 1 ? '1 field or word occurrence differs' : `${rollup.meaning} fields and word occurrences differ`}`;
  return <section className="agentic-comparison" aria-label="Compare saved and proposed files" aria-busy={loading}>
    <Button size="sm" variant="secondary" disabled={loading} onClick={() => void compare()}>{loading ? 'Loading saved files…' : error ? 'Retry saved-file comparison' : baseline ? 'Refresh saved-file comparison' : 'Compare with saved files'}</Button>
    {loading && <p role="status">Loading this phase’s saved files for comparison…</p>}
    {error && <p role="alert" className="agentic-action-error">{error}</p>}
    {baseline && <>
      <p className="agentic-review-note">Saved files when you loaded this comparison → proposed files. Unsaved workspace edits are not included. This comparison does not confirm that the proposal is still current.</p>
      {rollup.flag && <Notice tone="warn" role="note" testId="proposal-churn-flag">
        The line diff counts {rollup.lineChurn} changed lines across {rollup.files} {rollup.files === 1 ? 'file' : 'files'}, and {counted}. Read the summary under each file before you explain it.
        {asked && <> Your request said “{asked}”.</>}
      </Notice>}
      {compared.map(file => {
        const { path, original } = file;
        return <details key={path} open={file.changed} className="agentic-file-comparison">
          <summary>{path}: {original === undefined ? 'Not in the saved editable files' : file.changed ? `${file.diff.dels} removed, ${file.diff.adds} added` : 'Unchanged'}</summary>
          <FileDiffBody {...file} />
        </details>;
      })}
    </>}
  </section>;
}

/**
 * One file's measured change: the summary of what the bytes say, the changed
 * lines with their context, and the complete saved copy. Drawn under each file
 * of the saved-file comparison, and in the before/after overlay for a file a
 * story proposal touches beside the record.
 */
function FileDiffBody(file: ComparedFile) {
  const { path, original } = file;
  return <>
    <ProposalChangeSummary analysis={file.analysis} />
    {file.changed ? file.diff.hunks.length > 0 ? <div className="agentic-diff-scroll" tabIndex={0} role="region" aria-label={`Changed lines: ${path}`}>
      <table>
        <thead><tr><th scope="col">Change</th><th scope="col">Line</th><th scope="col">Content</th></tr></thead>
        {file.diff.hunks.map((hunk, hunkIndex) => <tbody key={hunkIndex}>
          {hunk.skipped > 0 && <tr><td colSpan={3}>{hunk.skipped} unchanged lines before this section</td></tr>}
          {hunk.lines.map((line, index) => <tr key={index} data-change={line.kind}>
            <th scope="row">{line.kind === '+' ? 'Added' : line.kind === '-' ? 'Removed' : 'Context'}</th>
            <td>{line.kind === '-' ? line.oldNo : line.newNo}</td>
            <td><code>{line.text || ' '}</code></td>
          </tr>)}
        </tbody>)}
      </table>
    </div> : <p>The text matches line by line, but line endings or the final newline differ. Inspect the complete proposed file below.</p> : <p>The saved and proposed contents match.</p>}
    {original !== undefined && <details className="agentic-complete-copy"><summary>Read complete saved copy</summary><pre tabIndex={0} aria-label={`Saved source: ${path}`}>{original}</pre></details>}
  </>;
}

/**
 * One proposed file against a saved copy the caller already holds, measured
 * once per pair of copies and drawn exactly as the saved-file comparison
 * draws it. `original` is undefined for a file the saved workspace lacks.
 */
export function ProposedFileDiff({ path, original, content }: { path: string; original: string | undefined; content: string }) {
  const file: ComparedFile = useMemo(() => {
    if (original === content) return { path, original, content, changed: false, diff: null, analysis: null };
    const diff = fileDiff(path, original, content);
    return { path, original, content, changed: true, diff, analysis: analyseChange(path, original, content, diff) };
  }, [path, original, content]);
  return <div className="agentic-file-comparison">
    <p className="agentic-review-note">{original === undefined ? 'Not in the saved editable files' : file.changed ? `${file.diff.dels} removed, ${file.diff.adds} added` : 'Unchanged'}</p>
    <FileDiffBody {...file} />
  </div>;
}
