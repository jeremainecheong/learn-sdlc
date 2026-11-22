'use client';

/**
 * The operations the design offers: each one's name, what goes in, what comes
 * back, how it fails, an optional note and the stories it serves. Inputs and
 * errors are typed one per line and kept as lists.
 */
import { DESIGN_CAPS, type DesignOperation } from '@learnsdlc/shared';
import { Panel, SectionHead } from '@/components/ui';
import { AutoText, CELL, Line, LinesText, MONO_CELL } from './cells';
import { AssistantMark, SMALL_BTN, StoryToggles, optional } from './BoardCards';
import { emptyOperation } from './model';
import type { DesignState } from './useDesign';

/*
 * The empty boxes' grey words are examples that belong to no project: a placeholder from another domain (a
 * library's "404 when no book has that id") would read, under an operation whose optional Errors box is left blank,
 * as if the operation failed with that error. Errors is optional (no design check asks for one), and its box says
 * so. These are placeholders only: no label, value or saved field.
 */
export function OperationsCard({ design }: { design: DesignState }) {
  const { doc, write, stories, busy } = design;
  const operations = doc.operations;
  const set = (next: DesignOperation[]) => write({ ...doc, operations: next });
  const patch = (i: number, p: Partial<DesignOperation>) => set(operations.map((o, k) => (k === i ? { ...o, ...p } : o)));
  const setNote = (i: number, value: string) =>
    set(operations.map((o, k) => {
      if (k !== i) return o;
      const { note: _gone, ...rest } = o;
      return { ...rest, ...optional('note', value) };
    }));
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="design-operations">
      <SectionHead
        title="Operations"
        purpose="What the design can be asked to do: its name, what goes in, what comes back and how it fails."
      />
      {operations.length === 0 && <p className="label-sm wrap">No operations yet. Add the first thing your design can do.</p>}
      {operations.map((o, i) => {
        const id = (field: string) => `design-operation-${i}-${field}`;
        return (
          <Panel key={o.id} className="flex flex-col gap-2 p-3" testId={`design-operation-${i}`}>
            <AssistantMark fields={design.assisted(`design/operation-${i + 1}`, ['name', 'inputs', 'returns', 'errors', 'satisfies', 'note'])} testId={id('touched')} />
            <Line label="Name" htmlFor={id('name')}>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id={id('name')}
                  className={`${MONO_CELL} min-w-[160px] flex-1 font-semibold`}
                  value={o.name}
                  maxLength={DESIGN_CAPS.fieldChars}
                  placeholder="e.g. operationName(input)"
                  disabled={busy}
                  data-testid={id('name')}
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                <button type="button" className={SMALL_BTN} disabled={busy} data-testid={id('remove')} onClick={() => set(operations.filter((_, k) => k !== i))}>
                  Remove
                </button>
              </div>
            </Line>
            <Line label="Inputs, one per line" htmlFor={id('inputs')}>
              <LinesText
                id={id('inputs')}
                className={CELL}
                items={o.inputs}
                maxItems={DESIGN_CAPS.listItems}
                placeholder="e.g. input: type"
                disabled={busy}
                data-testid={id('inputs')}
                onItems={(inputs) => patch(i, { inputs })}
              />
            </Line>
            <Line label="Returns" htmlFor={id('returns')}>
              <AutoText
                id={id('returns')}
                className={CELL}
                value={o.returns}
                maxLength={DESIGN_CAPS.fieldChars}
                placeholder="e.g. what comes back, and when"
                disabled={busy}
                data-testid={id('returns')}
                onChange={(e) => patch(i, { returns: e.target.value })}
              />
            </Line>
            <Line label="Errors, one per line" htmlFor={id('errors')}>
              <LinesText
                id={id('errors')}
                className={CELL}
                items={o.errors}
                maxItems={DESIGN_CAPS.listItems}
                placeholder="Optional: how it can fail"
                disabled={busy}
                data-testid={id('errors')}
                onItems={(errors) => patch(i, { errors })}
              />
            </Line>
            <Line label="Note: ordering, boundary or an example" htmlFor={id('note')}>
              <AutoText
                id={id('note')}
                className={CELL}
                value={o.note ?? ''}
                maxLength={DESIGN_CAPS.fieldChars}
                placeholder="the order it returns, a boundary case, or one call and what it gives back"
                disabled={busy}
                data-testid={id('note')}
                onChange={(e) => setNote(i, e.target.value)}
              />
            </Line>
            <StoryToggles
              stories={stories}
              picked={o.satisfies}
              label="Stories it serves"
              disabled={busy}
              testId={(storyId) => `design-operation-${i}-story-${storyId}`}
              onChange={(satisfies) => patch(i, { satisfies })}
            />
          </Panel>
        );
      })}
      <div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy || operations.length >= DESIGN_CAPS.operations}
          data-testid="design-operation-add"
          onClick={() => set([...operations, emptyOperation(operations)])}
        >
          Add an operation
        </button>
      </div>
    </div>
  );
}
