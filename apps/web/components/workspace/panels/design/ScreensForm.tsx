'use client';

/**
 * The screen contract as a form: one card per screen, a labelled input per
 * field the review reads. Each change rewrites the contract with the edited
 * row patched in place, so every key the form does not edit (a comment, the
 * router, a row's other keys) is kept as it was saved.
 *
 * The contract refuses a screen with no route, and a refused document holds
 * back the whole save. So a screen without a route never reaches the
 * contract: a new screen stays in this form until it has one, and a saved
 * screen whose route is cleared keeps its saved route until a new one is
 * typed. The form says so under the route, and reports either as an unsaved
 * edit (`onPendingDraftChange`, as the API workbench reports its drafts), so
 * the room holds Check, Submit and an Agentic Apply until each has a route.
 *
 * Each card is keyed by a local id that stays with its screen, never by its
 * position: a new screen that gets its route joins the contract ahead of the
 * new screens still being typed, and its card moves there with it.
 */
import { useEffect, useRef, useState } from 'react';
import { DESIGN_CAPS, isObject } from '@learnsdlc/shared';
import { Notice, Panel, SectionHead } from '@/components/ui';
import { AssistantMark } from './BoardCards';
import { AutoText, CELL, ListInput, MONO_CELL } from './cells';

type Row = Record<string, unknown>;
type Contract = Record<string, unknown> & { screens: Row[] };
/** A screen still without a route, held in the form under its local id. */
type Pending = { key: string; row: Row };

/**
 * The contract when the form can edit it: JSON holding a list of screen
 * objects. A screen still without a route is a row being typed into, so it
 * opens; anything else is the teacher's to reset and is never written over.
 */
function openContract(text: string | undefined): Contract | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? '');
  } catch {
    return null;
  }
  if (!isObject(raw) || !Array.isArray(raw.screens)) return null;
  const rows = raw.screens as unknown[];
  if (!rows.every((row) => isObject(row) && (row.route === undefined || typeof row.route === 'string'))) return null;
  return raw as Contract;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const capped = (v: string) => v.slice(0, DESIGN_CAPS.fieldChars);
const routed = (row: Row) => text(row.route).trim() !== '';

const EMPTY_SCREEN = { route: '', title: '', component: '', reads: [], shows: '', components: [], empty: '' };

export function ScreensForm({
  text: source,
  onChange,
  editable,
  assisted,
  onPendingDraftChange,
}: {
  text: string | undefined;
  onChange: (next: string) => void;
  editable: boolean;
  /** The fields of a screen the assistant wrote (`DesignState.assisted`); none when absent. */
  assisted?: (item: string, fields?: string[]) => string[];
  /** Told whether the form holds an edit the contract does not: a screen without a route, or a cleared route. */
  onPendingDraftChange?: (pending: boolean) => void;
}) {
  const doc = openContract(source);
  const saved = doc?.screens.length ?? 0;
  // Screens still without a route, held here until they have one.
  const [pending, setPending] = useState<Pending[]>([]);
  // The local ids of the saved screens, in order. Screens written from
  // outside the form (an applied proposal, a refresh) that change how many
  // there are take fresh ids by position.
  const [ids, setIds] = useState<string[]>([]);
  const made = useRef(0);
  // the rows still there keep their ids (and any route being typed); only rows the outside added take new ones
  const savedIds = ids.length === saved ? ids : extendIds(ids, saved);
  // A saved screen's route as the learner is typing it, while it is blank, by the screen's id: the contract keeps the saved route.
  const [routeDrafts, setRouteDrafts] = useState<Record<string, string>>({});
  const unsaved = pending.length > 0 || savedIds.some((id) => routeDrafts[id] !== undefined);
  useEffect(() => { onPendingDraftChange?.(unsaved); }, [unsaved, onPendingDraftChange]);
  // Once the form is gone, so is everything it held.
  useEffect(() => () => onPendingDraftChange?.(false), [onPendingDraftChange]);
  if (!doc) {
    return (
      <Notice tone="warn" role="status">
        The screen contract cannot be opened. Ask your teacher to reset its starting point.
      </Notice>
    );
  }
  const write = (screens: Row[]) => onChange(`${JSON.stringify({ ...doc, screens }, null, 2)}\n`);
  const withoutDraft = (id: string) => Object.fromEntries(Object.entries(routeDrafts).filter(([k]) => k !== id));
  const rows: { key: string; row: Row }[] = [
    ...doc.screens.map((row, i) => ({ key: savedIds[i], row: routeDrafts[savedIds[i]] !== undefined ? { ...row, route: routeDrafts[savedIds[i]] } : row })),
    ...pending,
  ];
  const patch = (index: number, change: Row) => {
    if (index >= saved) {
      // a screen being typed into joins the contract once it has a route, and keeps its id
      const at = index - saved;
      const next = { key: pending[at].key, row: { ...pending[at].row, ...change } };
      if (routed(next.row)) {
        setPending(pending.filter((_, k) => k !== at));
        setIds([...savedIds, next.key]);
        write([...doc.screens, next.row]);
      } else setPending([...pending.slice(0, at), next, ...pending.slice(at + 1)]);
      return;
    }
    const id = savedIds[index];
    if ('route' in change) {
      if (!routed(change)) {
        // a cleared route stays here; the contract keeps the saved one
        setRouteDrafts({ ...routeDrafts, [id]: text(change.route) });
        return;
      }
      setRouteDrafts(withoutDraft(id));
    }
    // any other field is written at once; a cleared route's draft stays until a route is typed
    write(doc.screens.map((row, i) => (i === index ? { ...row, ...change } : row)));
  };
  const remove = (index: number) => {
    if (index >= saved) {
      setPending(pending.filter((_, k) => k !== index - saved));
      return;
    }
    setRouteDrafts(withoutDraft(savedIds[index]));
    setIds(savedIds.filter((_, k) => k !== index));
    write(doc.screens.filter((_, k) => k !== index));
  };

  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="design-screens">
      <SectionHead
        title="Screens"
        purpose="Each screen the learner sees: where it lives, what it reads, what it shows and what it says when there is nothing to show."
      />
      {rows.length === 0 && <p className="label-sm wrap">No screens yet. Add the first one.</p>}
      {rows.map(({ key, row }, i) => {
        const id = (field: string) => `design-screen-${i}-${field}`;
        const empty = text(row.empty);
        return (
          <Panel key={key} className="flex flex-col gap-2 p-3" testId={`design-screen-${i}`}>
            {i < saved && assisted && (
              <AssistantMark
                fields={assisted(`screens/screen-${i + 1}`, ['route', 'title', 'component', 'reads', 'shows', 'components', 'empty'])}
                testId={id('touched')}
              />
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Route" htmlFor={id('route')}>
                <input
                  id={id('route')}
                  className={MONO_CELL}
                  value={text(row.route)}
                  placeholder="#/books"
                  disabled={!editable}
                  data-testid={id('route')}
                  aria-describedby={!text(row.route).trim() ? id('route-missing') : undefined}
                  onChange={(e) => patch(i, { route: capped(e.target.value) })}
                />
                {!text(row.route).trim() && (
                  <span className="label-sm" id={id('route-missing')} data-testid={id('route-missing')}>
                    {i < saved
                      ? `A screen needs a route. Your saved route ${text(doc.screens[i].route)} is kept until you type a new one.`
                      : 'A screen needs a route. This screen is kept here, unsaved, until it has one.'}
                  </span>
                )}
              </Field>
              <Field label="Title" htmlFor={id('title')}>
                <input
                  id={id('title')}
                  className={CELL}
                  value={text(row.title)}
                  placeholder="Every book"
                  disabled={!editable}
                  data-testid={id('title')}
                  onChange={(e) => patch(i, { title: capped(e.target.value) })}
                />
              </Field>
              <Field label="Component" htmlFor={id('component')}>
                <input
                  id={id('component')}
                  className={MONO_CELL}
                  value={text(row.component)}
                  placeholder="BooksPage"
                  disabled={!editable}
                  data-testid={id('component')}
                  onChange={(e) => patch(i, { component: capped(e.target.value) })}
                />
              </Field>
              <Field label="Operations it reads, separated by commas" htmlFor={id('reads')}>
                <ListInput
                  id={id('reads')}
                  className={MONO_CELL}
                  items={strings(row.reads)}
                  placeholder="listBooks"
                  disabled={!editable}
                  data-testid={id('reads')}
                  onItems={(reads) => patch(i, { reads })}
                />
              </Field>
            </div>
            <Field label="What it shows" htmlFor={id('shows')}>
              <AutoText
                id={id('shows')}
                className={CELL}
                value={text(row.shows)}
                placeholder="every book on the shelf, by title"
                disabled={!editable}
                data-testid={id('shows')}
                onChange={(e) => patch(i, { shows: capped(e.target.value) })}
              />
            </Field>
            <Field label="Components it renders, separated by commas" htmlFor={id('components')}>
              <ListInput
                id={id('components')}
                className={MONO_CELL}
                items={strings(row.components)}
                placeholder="BookList, EmptyState"
                disabled={!editable}
                data-testid={id('components')}
                onItems={(components) => patch(i, { components })}
              />
            </Field>
            <Field label="What it says when there is nothing to show" htmlFor={id('empty')}>
              <AutoText
                id={id('empty')}
                className={CELL}
                value={empty}
                placeholder="No books yet. Add the first one to see it here."
                disabled={!editable}
                data-testid={id('empty')}
                aria-describedby={empty.trim().length < DESIGN_CAPS.emptySentence ? id('empty-short') : undefined}
                onChange={(e) => patch(i, { empty: capped(e.target.value) })}
              />
              {empty.trim().length < DESIGN_CAPS.emptySentence && (
                <span className="label-sm" id={id('empty-short')}>At least {DESIGN_CAPS.emptySentence} characters</span>
              )}
            </Field>
            <div>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!editable}
                data-testid={id('remove')}
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </div>
          </Panel>
        );
      })}
      <div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={!editable}
          data-testid="design-screen-add"
          onClick={() => setPending([...pending, { key: `new-${(made.current += 1)}`, row: { ...EMPTY_SCREEN } }])}
        >
          Add a screen
        </button>
      </div>
    </div>
  );
}

/** `ids` cut or grown to `count`: the ones kept stay as they are, each new one `saved-N` for the first N no row holds. */
function extendIds(ids: string[], count: number): string[] {
  const out = ids.slice(0, count);
  for (let n = out.length; out.length < count; n += 1) if (!out.includes(`saved-${n}`)) out.push(`saved-${n}`);
  return out;
}

/** A stacked label over its field: the screen rows sit two to a line, so the cards' side-by-side `Line` would not fit. */
function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="label-sm" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}
