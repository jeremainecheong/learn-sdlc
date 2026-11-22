'use client';

import type { PhaseDetail } from '@learnsdlc/shared';
import { validateStoryRecord } from '@learnsdlc/shared';
import { IssueDialog } from '../panels/requirements/IssueDesk';
import { STORY_JSON } from '../panels/requirements/story';
import { storyPartText } from '../panels/requirements/storySentence';

function Snapshot({ title, files }: { title: string; files: Record<string, string> }) {
  const record = files[STORY_JSON] ?? '';
  const { story } = record.trim() ? validateStoryRecord(record) : { story: null };
  return <section className="requirements-conflict-copy" aria-label={title}>
    <h3>{title}</h3>
    {story ? <>
      <h4>{story.id}: {story.title || 'Untitled story'}</h4>
      <dl>{[['As a', storyPartText('persona', story.persona)], ['I want', storyPartText('capability', story.capability)], ['So that', storyPartText('benefit', story.benefit)], ['Parent epic', story.parentEpicId]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Not specified'}</dd></div>)}</dl>
      <h4>Acceptance criteria</h4>
      {story.criteria.length ? <ol>{story.criteria.map(criterion => <li key={criterion.id}><strong>{criterion.id}: {criterion.tag}</strong><p>Given {criterion.given || '…'}</p><p>When {criterion.when || '…'}</p><p>Then {criterion.then || '…'}</p></li>)}</ol> : <p>No criteria yet.</p>}
      <h4>Epics</h4>
      {story.epics?.length ? <ul>{story.epics.map(epic => <li key={epic.id}><strong>{epic.id}: {epic.title || 'Untitled epic'}</strong><p>{epic.outcome || 'No outcome yet.'}</p></li>)}</ul> : <p>No epics yet.</p>}
      <h4>Out of scope</h4><p>{story.scopeExclusions.filter(Boolean).join('; ') || 'Not specified'}</p>
      <h4>Open questions</h4><p>{story.notes || 'None recorded'}</p>
    </> : <p>{record.trim() ? 'The story record cannot be read.' : 'No story saved yet.'}</p>}
  </section>;
}

export function SaveConflictDialog({ conflict, files, saving, onResolve, onClose }: {
  conflict: PhaseDetail;
  files: Record<string, string>;
  saving: boolean;
  onResolve: (choice: 'saved' | 'draft', reviewedVersion: string) => void;
  onClose: () => void;
}) {
  const saved = Object.fromEntries(conflict.files.map(file => [file.path, file.content]));
  const version = conflict.workspaceUpdatedAt ?? '';
  return <IssueDialog title="Compare Requirements versions" wide onClose={onClose}>
    <div className="requirements-conflict-body">
      <p>Another tab or device saved different work. Compare both versions before choosing. No submission or verdict changes here.</p>
      <div className="requirements-conflict-columns"><Snapshot title="Your local draft" files={files} /><Snapshot title="Saved on the server" files={saved} /></div>
    </div>
    <footer className="requirements-conflict-actions"><p>Use saved version discards your local draft. Save my draft replaces the compared story and epics.</p><button type="button" className="btn-secondary btn-sm" onClick={onClose}>Keep comparing later</button><button type="button" className="btn-secondary btn-sm" disabled={saving} onClick={() => onResolve('saved', version)}>Use saved version</button><button type="button" className="btn btn-sm" disabled={saving} onClick={() => onResolve('draft', version)}>Save my draft</button></footer>
  </IssueDialog>;
}
