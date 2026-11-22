'use client';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState } from 'react';
import { Notice } from '@/components/ui';
import { useLessonsVisible, useProjectName } from '@/lib/scenario';
import { AssistantMark } from './BoardCards';
const PATH = 'shared/contract/api.json';
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const string = (value: unknown) => typeof value === 'string' ? value : '';
type FieldDraft = { text: string; error: string };
type DraftProps = { draft?: FieldDraft; setDraft: (draft: FieldDraft | undefined) => void };
function JsonField({ label, value, onChange, draft, setDraft }: { label: string; value: unknown; onChange: (value: unknown) => void } & DraftProps) {
 const errorId = useId();
 const text = draft?.text ?? JSON.stringify(value, null, 2) ?? '';
 const commit = () => {
  if (!draft) return;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { setDraft({ text, error: 'Enter valid JSON before leaving this field. This invalid draft has not been saved.' }); return; }
  onChange(parsed); setDraft(undefined);
 };
 return <label>{label}<textarea aria-label={label} aria-invalid={!!draft?.error} aria-describedby={draft?.error ? errorId : undefined} rows={6} value={text} spellCheck={false} onChange={event => setDraft({ text: event.target.value, error: '' })} onBlur={commit} />{draft?.error && <span id={errorId} role="alert">{draft.error}</span>}</label>;
}
function StatusField({ value, onChange, draft, setDraft }: { value: unknown; onChange: (value: number | undefined) => void } & DraftProps) {
 const errorId = useId();
 const text = draft?.text ?? (typeof value === 'number' ? String(value) : '');
 const commit = () => {
  if (!draft) return;
  if (!text.trim()) { onChange(undefined); setDraft(undefined); return; }
  const status = Number(text);
  if (!/^\d{3}$/.test(text) || status < 100 || status > 599) { setDraft({ text, error: 'Use an HTTP status from 100 to 599. This invalid draft has not been saved.' }); return; }
  onChange(status); setDraft(undefined);
 };
 return <label>Success status<input aria-label="Success status" aria-invalid={!!draft?.error} aria-describedby={draft?.error ? errorId : undefined} inputMode="numeric" value={text} onChange={event => setDraft({ text: event.target.value, error: '' })} onBlur={commit} />{draft?.error && <span id={errorId} role="alert">{draft.error}</span>}</label>;
}
/**
 * A new endpoint: every field the workbench edits, empty, under an id no other
 * endpoint holds (the id keys its waiting drafts and the assistant's marks).
 */
function newEndpoint(operations: JsonRecord[]): JsonRecord {
 const ids = new Set(operations.map(item => string(item.id)));
 // numbered past the highest endpointN the contract holds, so a removed one in the middle is not taken again
 const highest = Math.max(0, ...operations.map(item => Number(/^endpoint(\d+)$/.exec(string(item.id))?.[1] ?? 0)));
 let n = Math.max(operations.length, highest) + 1;
 while (ids.has(`endpoint${n}`)) n += 1;
 return { id: `endpoint${n}`, method: 'GET', path: '', summary: '', query: [], body: {}, success: {}, errors: [], 'x-example': {} };
}
/** The waiting drafts once endpoint `removed` is gone: its own are dropped, and those after it move up one. */
function draftsWithout(drafts: Record<string, FieldDraft | undefined>, removed: number) {
 const out: Record<string, FieldDraft | undefined> = {};
 for (const [key, draft] of Object.entries(drafts)) {
  const at = /^(\d+):(.*)$/.exec(key);
  if (!at) { out[key] = draft; continue; }
  const index = Number(at[1]);
  if (index !== removed) out[index > removed ? `${index - 1}:${at[2]}` : key] = draft;
 }
 return out;
}
/**
 * Edits the actual assessment contract; Preview only formats authored example data.
 * `audience` is whose surface draws it: the learner's room (the default) says the
 * contract is saved with their design and links the contract guide; the teacher's
 * Starting point says neither.
 */
export function ApiWorkbench({ files, setFile, onPendingDraftChange, assisted, audience = 'learner' }: { files: Record<string, string>; setFile: (path: string, content: string) => void; onPendingDraftChange?: (pending: boolean) => void; assisted?: (item: string, fields?: string[]) => string[]; audience?: 'learner' | 'teacher' }) {
 // Invalid field drafts belong to an operation, not its currently mounted tab.
 const [drafts, setDrafts] = useState<Record<string, FieldDraft | undefined>>({});
 useEffect(() => { onPendingDraftChange?.(Object.values(drafts).some(Boolean)); }, [drafts, onPendingDraftChange]);
 const draftProps = (key: string): DraftProps => ({ draft: drafts[key], setDraft: draft => setDrafts(previous => ({ ...previous, [key]: draft })) });
 const [selected, setSelected] = useState(0);
 // The learner's own project, never a fixed "TaskTrackr".
 const project = useProjectName() || 'Your project';
 // The guide teaches the reference project's contract,
 // so it is linked only where Design still is the reference project's.
 const lessons = useLessonsVisible('design');
 const [tab, setTab] = useState<'contract' | 'params' | 'body' | 'errors' | 'example'>('contract');
 const parsed = useMemo(() => { try { const doc = record(JSON.parse(files[PATH] ?? '{}')); if (!Array.isArray(doc.operations)) return null; return doc; } catch { return null; } }, [files]);
 if (!parsed) return <Notice tone="warn">{audience === 'teacher'
  ? 'The starting API contract cannot be read, so this form cannot open it. It is kept exactly as it was saved: replace it, or reset it to the pack\'s.'
  : 'Your saved API contract cannot be read, so this form cannot open it. The form never writes over it: it is kept exactly as it was saved. Ask your teacher to reset its starting point.'}</Notice>;
 const operations = (parsed.operations as unknown[]).map(record);
 const index = Math.min(selected, Math.max(0, operations.length - 1));
 const operation = operations[index];
 const write = (doc: JsonRecord) => setFile(PATH, JSON.stringify(doc, null, 2) + '\n');
 const add = () => { write({ ...parsed, operations: [...operations, newEndpoint(operations)] }); setSelected(operations.length); };
 const addButton = <button type="button" className="btn-secondary btn-sm design-collection-add" onClick={add}>Add an endpoint</button>;
 const header = <header className="design-workbench-top"><strong>API collection</strong>{audience === 'learner' && <span className="label-sm">{project}: Saved with your design</span>}{audience === 'learner' && lessons && <Link className="label-sm ml-auto text-accent" href="/learn/design">Contract guide ↗</Link>}</header>;
 if (!operation) return <section className="design-workbench" aria-label="API contract workbench">{header}<div className="flex flex-col items-start gap-3 p-3"><p className="label-sm wrap">The contract has no endpoints yet. Add an endpoint to describe its first request.</p>{addButton}</div></section>;
 const remove = () => { write({ ...parsed, operations: operations.filter((_, i) => i !== index) }); setDrafts(previous => draftsWithout(previous, index)); };
 const patch = (changes: JsonRecord) => write({ ...parsed, operations: operations.map((item, i) => i === index ? { ...item, ...changes } : item) });
 const fieldKey = (field: string) => `${index}:${string(operation.id)}:${field}`;
 const success = record(operation.success);
 const queries = Array.isArray(operation.query) ? operation.query : [];
 return <section className="design-workbench" aria-label="API contract workbench">
  {header}
  <div className="design-workbench-body"><nav className="design-collection" aria-label="API operations">{operations.map((item, i) => <button type="button" key={`${string(item.id)}-${i}`} aria-pressed={index === i} onClick={() => setSelected(i)}><small>{string(item.method)} </small><span>{string(item.id) || `Operation ${i + 1}`}</span></button>)}{addButton}</nav>
   {/* Keep request controls and section navigation mounted so focus and tab scroll survive selection. */}
   <div className="design-contract-editor">{assisted && <AssistantMark fields={[...assisted(`api/endpoint-${index + 1}`, ['id', 'route', 'summary', 'query', 'body', 'success', 'errors', 'example']), ...assisted('api/errors').map(() => 'error catalogue')]} testId="design-api-touched" />}<div className="design-request-line"><label><span className="sr-only">HTTP method</span><select value={string(operation.method)} onChange={event => patch({ method: event.target.value })}>{['GET','POST','PUT','PATCH','DELETE'].map(method => <option key={method}>{method}</option>)}</select></label><label className="flex-1"><span className="sr-only">Path</span><input value={string(operation.path)} onChange={event => patch({ path: event.target.value })} placeholder="/api/resource/{id}" /></label></div>
   <div className="mentor-mode-switch" aria-label="Contract sections">{(['contract','params','body','errors','example'] as const).map(key => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{key[0].toUpperCase() + key.slice(1)}</button>)}</div>
   {tab === 'contract' && <><label>Behavior and boundaries<textarea aria-label="Behavior and boundaries" rows={3} value={string(operation.summary)} onChange={event => patch({ summary: event.target.value })} /></label><div className="design-contract-grid"><label>Stories satisfied<input value={string(operation.satisfies)} onChange={event => patch({ satisfies: event.target.value })} placeholder="US-…" /></label><StatusField {...draftProps(fieldKey('status'))} value={success.status} onChange={status => patch({ success: { ...success, status } })} /></div><label>Success body shape<input value={string(success.body)} onChange={event => patch({ success: { ...success, body: event.target.value } })} placeholder="Describe the returned contract type" /></label></>}
   {tab === 'params' && <><p className="purpose">Define each accepted query parameter and its semantics. These are contract fields, not a network request.</p>{queries.map((raw, i) => { const query = record(raw); return <div className="design-contract-grid" key={i}><label>Name<input value={string(query.name)} onChange={event => patch({ query: queries.map((item, qi) => qi === i ? { ...query, name: event.target.value } : item) })} /></label><label>Type / allowed values<input value={string(query.type)} onChange={event => patch({ query: queries.map((item, qi) => qi === i ? { ...query, type: event.target.value } : item) })} /></label><label>Description<input value={string(query.description)} onChange={event => patch({ query: queries.map((item, qi) => qi === i ? { ...query, description: event.target.value } : item) })} /></label><button type="button" className="btn-ghost btn-sm" onClick={() => patch({ query: queries.filter((_, qi) => qi !== i) })}>Remove parameter {i + 1}</button></div>; })}<button type="button" className="btn-secondary btn-sm" onClick={() => patch({ query: [...queries, { name: '', type: '', description: '' }] })}>Add parameter</button></>}
   {tab === 'body' && <JsonField {...draftProps(fieldKey('body'))} label="Request body contract (JSON)" value={operation.body ?? {}} onChange={body => patch({ body })} />}
   {tab === 'errors' && <><JsonField {...draftProps(fieldKey('errors'))} label="Error codes this operation can return (JSON array)" value={operation.errors ?? []} onChange={errors => patch({ errors })} /><JsonField {...draftProps('shared:errors')} label="Shared error catalogue (JSON object, code → status and meaning)" value={parsed.errors ?? {}} onChange={errors => write({ ...parsed, errors })} /></>}
   {tab === 'example' && <><p className="purpose">An authored example illustrates your response contract. It does not send a request, run code, or prove the contract is implemented.</p><JsonField {...draftProps(fieldKey('example'))} label="Authored response example (JSON)" value={operation['x-example'] ?? {}} onChange={value => patch({ 'x-example': value })} /><pre className="mono text-xs overflow-auto p-3">{JSON.stringify(operation['x-example'] ?? {}, null, 2)}</pre></>}
   <button type="button" className="btn-ghost btn-sm" onClick={remove}>Remove this endpoint</button>
   </div>
  </div>
 </section>;
}
