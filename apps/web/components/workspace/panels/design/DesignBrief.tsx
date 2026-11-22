'use client';

/**
 * The brief-pane summary: what the design is made of so far, counted from
 * the same record the Design room edits, how many contradictions it still has
 * to settle, and the door into the room.
 */
import { useMemo } from 'react';
import { DESIGN_OLDER_FORMAT_ROOM } from '@learnsdlc/shared';
import { StatusSquare } from '@/components/ui';
import type { StatusState } from '@/lib/phase';
import type { PhasePanelProps } from '../types';
import { contractWarnings, storyFacts } from './contradictions';
import { count, designDrift, sentence } from './DesignBoard';
import { designView } from './useDesign';
import { useOwnStoryRecord } from './useStories';

interface Part {
  title: string;
  detail: string;
  state: StatusState;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const counted = (n: number, one: string, many: string, none: string): Part['detail'] => (n ? `${plural(n, one, many)}.` : none);

export function DesignBrief({ detail, files, enrollment, helpers }: PhasePanelProps) {
  const view = useMemo(() => designView(files, detail.files, detail.design), [files, detail.files, detail.design]);
  // The same contradictions the Design room draws, from the same stories and
  // the learner's own story record, so the brief and the room report one number.
  const ownRecord = useOwnStoryRecord(enrollment);
  const warnings = useMemo(() => {
    if (view.olderFormat || view.broken) return 0;
    return contractWarnings({ design: view.doc, facts: storyFacts(detail.design?.stories ?? [], ownRecord) }).length;
  }, [view, detail.design?.stories, ownRecord]);

  const parts = useMemo<Part[]>(() => {
    if (view.olderFormat) return [];
    if (view.broken) return [{ title: 'Your design', detail: `It cannot be opened: ${view.broken}.`, state: 'fail' }];
    const doc = view.doc;
    const attributes = doc.entities.reduce((sum, e) => sum + e.attributes.filter((a) => a.name.trim()).length, 0);
    const accepted = doc.decisions.filter((d) => d.status === 'accepted').length;
    const drift = designDrift(doc, files);
    // Presence only (written or not yet), never the floor's verdict: a written part is 'done', never a green pass.
    return [
      {
        title: 'Data model',
        detail: doc.entities.length
          ? `${plural(doc.entities.length, 'entity', 'entities')}, ${plural(attributes, 'attribute', 'attributes')}.`
          : 'No entities yet.',
        state: doc.entities.length ? 'done' : 'todo',
      },
      {
        title: 'Relations',
        detail: counted(doc.relations.length, 'relation', 'relations', 'No relations yet.'),
        state: doc.relations.length ? 'done' : 'todo',
      },
      {
        title: 'Operations',
        detail: counted(doc.operations.length, 'operation', 'operations', 'No operations yet.'),
        state: doc.operations.length ? 'done' : 'todo',
      },
      {
        title: 'Decisions',
        detail: doc.decisions.length ? `${plural(doc.decisions.length, 'decision', 'decisions')}, ${accepted} accepted.` : 'No decisions yet.',
        state: accepted ? 'done' : doc.decisions.length ? 'warn' : 'todo',
      },
      {
        title: 'Class diagram',
        detail: !drift
          ? 'Drawn from your model and operations.'
          : drift.names.length === 0
            ? 'Drawn, no drift.'
            : `${plural(drift.names.length, 'function', 'functions')} in ${drift.path} that no operation names.`,
        state: !drift ? 'done' : drift.names.length === 0 ? 'done' : 'warn',
      },
    ];
  }, [files, view]);

  return (
    <section data-testid="phase-design-brief">
      <h2 className="h3">Your design</h2>
      <p className="purpose">The parts you write in the Design room. The diagram is drawn from them.</p>
      {view.olderFormat ? (
        <p className="label-sm wrap mt-2" data-testid="phase-design-older-format">{DESIGN_OLDER_FORMAT_ROOM}</p>
      ) : (
        <>
          <div className="mt-2 border-b-1.5 border-edge2 pb-1.5">
            <span className="label-sm">Part</span>
          </div>
          <ul className="m-0 list-none p-0">
            {parts.map((part) => (
              <li key={part.title} className="flex min-w-0 items-start gap-2 border-b-1.5 border-edge py-2">
                <StatusSquare state={part.state} className="mt-[3px]" />
                <div className="min-w-0">
                  <p className="wrap text-[13px] font-semibold text-ink">{part.title}</p>
                  <p className="label-sm wrap mt-0.5">{part.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          {warnings > 0 && (
            <p className="label-sm wrap mt-2 text-warn" data-testid="phase-design-brief-warnings">
              {/* counted in words, as the room counts them */}
              {sentence(`${count(warnings)} ${warnings === 1 ? 'contradiction' : 'contradictions'} to settle.`)}
            </p>
          )}
        </>
      )}
      <button
        type="button"
        className="btn-secondary btn-sm mt-3"
        data-testid="phase-design-open"
        onClick={() => {
          helpers.setTab('phase');
          helpers.setPane('panel');
        }}
      >
        Open the design editor
      </button>
    </section>
  );
}
