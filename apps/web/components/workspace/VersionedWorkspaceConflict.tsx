'use client';

import type { PhaseDetail } from '@learnsdlc/shared';
import { fileDiff } from '@/components/pr/diff';
import { IssueDialog } from './panels/requirements/IssueDesk';

/** Compare the exact editable copies before an explicit versioned choice. */
export function VersionedWorkspaceConflict({ title, conflict, files, saving, onResolve, onClose }: {
  title: string;
  conflict: PhaseDetail;
  files: Record<string, string>;
  saving: boolean;
  onResolve: (choice: 'saved' | 'draft', reviewedVersion: string) => void;
  onClose: () => void;
}) {
  const changed = conflict.files.filter(file => file.editable && files[file.path] !== undefined && files[file.path] !== file.content);
  return <IssueDialog title={`Compare ${title} versions`} wide onClose={onClose}>
    <div className="requirements-conflict-body">
      <p>Another tab or device saved different work. Review both copies before choosing. Your submissions and verdicts stay unchanged.</p>
      {changed.map(file => {
        const diff = fileDiff(file.path, file.content, files[file.path]);
        return <section key={file.path} className="mb-5 min-w-0">
        <h3 className="mono wrap mb-2">{file.path}</h3>
        <div role="region" aria-label={`Changed lines: ${file.path}`} className="mb-3 min-w-0 rounded-ctl border border-edge">
          <p className="border-b border-edge px-3 py-2 text-xs text-muted">{diff.dels} removed from the saved copy. {diff.adds} added in your draft.</p>
          {diff.hunks.length > 0 ? <div tabIndex={0} aria-label={`Scroll changed lines: ${file.path}`} className="max-h-[42vh] overflow-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sr-only"><tr><th>Change</th><th>Source line</th><th>Content</th></tr></thead>
              {diff.hunks.map((hunk, hunkIndex) => <tbody key={hunkIndex}>
                {hunk.skipped > 0 && <tr><td colSpan={3} className="bg-surface2 px-3 py-1.5 text-muted">{hunk.skipped} unchanged lines before this section</td></tr>}
                {hunk.lines.map((line, index) => <tr key={index} className={line.kind === '+' ? 'bg-passtint' : line.kind === '-' ? 'bg-failtint' : ''}>
                  <th scope="row" className="whitespace-nowrap px-3 py-1 align-top font-medium">{line.kind === '+' ? 'Added' : line.kind === '-' ? 'Removed' : 'Context'}</th>
                  <td className="px-2 py-1 align-top font-mono text-muted">{line.kind === '-' ? line.oldNo : line.newNo}</td>
                  <td className="px-3 py-1 align-top"><code className="whitespace-pre font-mono">{line.text || ' '}</code></td>
                </tr>)}
              </tbody>)}
            </table>
          </div> : <p className="px-3 py-2">The line text matches, but line endings or the final newline differ. Inspect the complete copies before choosing.</p>}
        </div>
        <details>
          <summary className="cursor-pointer py-3 font-medium text-ink">Read complete file copies</summary>
        <div className="requirements-conflict-columns">
          <section className="requirements-conflict-copy" aria-label={`Your local draft: ${file.path}`}>
            <h4>Your local draft</h4><pre tabIndex={0} aria-label={`Local source: ${file.path}`} className="max-h-[42vh] overflow-auto whitespace-pre text-xs leading-relaxed">{files[file.path]}</pre>
          </section>
          <section className="requirements-conflict-copy" aria-label={`Saved on the server: ${file.path}`}>
            <h4>Saved on the server</h4><pre tabIndex={0} aria-label={`Server source: ${file.path}`} className="max-h-[42vh] overflow-auto whitespace-pre text-xs leading-relaxed">{file.content}</pre>
          </section>
        </div>
        </details>
      </section>; })}
      {changed.length === 0 && <p>Your editable files match the compared server copy. Use saved version to acknowledge it.</p>}
    </div>
    <footer className="requirements-conflict-actions">
      <p>Use saved version discards your local draft. Save my draft replaces the compared editable files with your draft.</p>
      <button type="button" className="btn-secondary btn-sm" onClick={onClose}>Keep comparing later</button>
      <button type="button" className="btn-secondary btn-sm" disabled={saving} onClick={() => onResolve('saved', conflict.workspaceUpdatedAt ?? '')}>Use saved version</button>
      <button type="button" className="btn btn-sm" disabled={saving || changed.length === 0} onClick={() => onResolve('draft', conflict.workspaceUpdatedAt ?? '')}>Save my draft</button>
    </footer>
  </IssueDialog>;
}
