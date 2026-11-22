'use client';

/**
 * The model's own cards: the entities and components, the relations between
 * them, and the notes. The learner enters the design here and never in a
 * file; each change goes out through `design.write` as the whole record.
 *
 * An optional text field is never written as null or as an empty string the
 * learner cleared: it is left out of the record, as the record reads it.
 */
import { DESIGN_CAPS, type DesignEntity, type DesignRelation, type DesignStory } from '@learnsdlc/shared';
import { Chip, Panel, SectionHead } from '@/components/ui';
import { AutoText, CELL, MONO_CELL, SelectCell, capLine } from './cells';
import {
  CARDINALITIES,
  ENTITY_KINDS,
  RELATION_KINDS,
  emptyEntity,
  emptyRelation,
  type EntityKind,
  type RelationKind,
} from './model';
import type { DesignState } from './useDesign';

const RELATION_HELP: Record<RelationKind, string> = {
  association: 'uses or knows about',
  aggregation: 'has, and the part can live on its own',
  composition: 'owns, and the part dies with the whole',
  inheritance: 'is a kind of',
  dependency: 'depends on for a moment',
};

export const SMALL_BTN = 'btn-ghost btn-sm';
const FIELD = DESIGN_CAPS.fieldChars;

/**
 * An optional text field, as the record keeps it: the key with its text, or
 * no key at all once the learner clears it.
 */
export function optional<K extends string>(key: K, value: string): Partial<Record<K, string>> {
  return (value ? { [key]: value } : {}) as Partial<Record<K, string>>;
}

/** The record with one optional key set or removed. */
export function withOptional<T extends object, K extends keyof T & string>(row: T, key: K, value: string): T {
  const { [key]: _gone, ...rest } = row;
  return { ...rest, ...optional(key, value) } as T;
}

/** How a field's review path reads in the mark ('trade-off', 'superseded by'). */
const FIELD_WORD: Record<string, string> = { 'superseded-by': 'superseded by', note: 'note', empty: 'empty-state sentence' };

/**
 * "Changed by the assistant", on an item an applied Agentic proposal wrote,
 * naming the fields that still hold its text. A field the learner has since
 * rewritten loses its mark; a submit clears them all. Nothing when no field
 * of the item is marked.
 */
export function AssistantMark({ fields, testId }: { fields: string[]; testId: string }) {
  if (fields.length === 0) return null;
  const named = fields.filter(Boolean).map((f) => FIELD_WORD[f] ?? f);
  return (
    <Chip tone="outline" testId={testId} className="shrink-0 self-start">
      {named.length ? `Changed by the assistant: ${named.join(', ')}` : 'Changed by the assistant'}
    </Chip>
  );
}

/**
 * The stories this item satisfies: one toggle per story the phase lists, so
 * the learner never types an id.
 */
export function StoryToggles({
  stories,
  picked,
  onChange,
  testId,
  label,
  disabled,
}: {
  stories: DesignStory[];
  picked: string[];
  onChange: (next: string[]) => void;
  testId: (storyId: string) => string;
  label: string;
  disabled?: boolean;
}) {
  if (stories.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="label-sm">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {stories.map((s) => {
          const on = picked.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              title={s.title}
              disabled={disabled}
              data-testid={testId(s.id)}
              className={`rounded-chip border-1.5 px-2 py-0.5 text-[11.5px] font-medium ${
                on ? 'border-accent bg-tint text-accent' : 'border-edge2 text-ink2'
              }`}
              onClick={() => onChange(on ? picked.filter((id) => id !== s.id) : [...picked, s.id])}
            >
              <span className="mono">{s.id}</span> {s.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function EntitiesCard({ design }: { design: DesignState }) {
  const { doc, write, stories, busy } = design;
  const entities = doc.entities;
  const set = (next: DesignEntity[]) => write({ ...doc, entities: next });
  const patch = (i: number, p: Partial<DesignEntity>) => set(entities.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const remove = (i: number) => {
    const gone = entities[i].id;
    write({
      ...doc,
      entities: entities.filter((_, k) => k !== i),
      relations: doc.relations.filter((r) => r.from !== gone && r.to !== gone),
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="design-board-entities">
      <SectionHead
        title="Entities and components"
        purpose="Each box in the diagram: a class, a component, a service or a screen, what it holds and what it does."
      />
      {entities.length === 0 && <p className="label-sm wrap">No entities yet. Add the first thing your design is made of.</p>}
      {entities.map((e, i) => (
        <Panel key={e.id} className="flex flex-col gap-2 p-3" testId={`design-board-entity-${i}`}>
          <AssistantMark fields={design.assisted(`design/entity-${i + 1}`, ['name', 'kind', 'attributes', 'responsibilities', 'satisfies'])} testId={`design-board-entity-${i}-touched`} />
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${MONO_CELL} min-w-[160px] flex-1 font-semibold`}
              value={e.name}
              maxLength={FIELD}
              placeholder="Name, e.g. Book"
              aria-label={`Entity ${i + 1} name`}
              disabled={busy}
              data-testid={`design-board-entity-${i}-name`}
              onChange={(ev) => patch(i, { name: ev.target.value })}
            />
            <SelectCell
              value={e.kind}
              aria-label={`Entity ${i + 1} kind`}
              disabled={busy}
              data-testid={`design-board-entity-${i}-kind`}
              onChange={(ev) => patch(i, { kind: ev.target.value as EntityKind })}
            >
              {/* The record's word as a choice is named ("Class"), as the proposal's Compare names it. */}
              {ENTITY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.charAt(0).toUpperCase() + k.slice(1)}
                </option>
              ))}
            </SelectCell>
            <button type="button" className={SMALL_BTN} disabled={busy} data-testid={`design-board-entity-${i}-remove`} onClick={() => remove(i)}>
              Remove
            </button>
          </div>
          <span className="label-sm">Attributes</span>
          {e.attributes.map((a, j) => (
            <div key={j} className="flex items-center gap-2">
              <input
                className={`${MONO_CELL} flex-1`}
                value={a.name}
                maxLength={FIELD}
                placeholder="name"
                aria-label={`Entity ${i + 1} attribute ${j + 1} name`}
                disabled={busy}
                data-testid={`design-board-entity-${i}-attr-${j}-name`}
                onChange={(ev) =>
                  patch(i, { attributes: e.attributes.map((x, k) => (k === j ? { ...x, name: ev.target.value } : x)) })
                }
              />
              <span className="label-sm">:</span>
              <input
                className={`${MONO_CELL} flex-1`}
                value={a.type ?? ''}
                maxLength={FIELD}
                placeholder="type"
                aria-label={`Entity ${i + 1} attribute ${j + 1} type`}
                disabled={busy}
                data-testid={`design-board-entity-${i}-attr-${j}-type`}
                onChange={(ev) =>
                  patch(i, { attributes: e.attributes.map((x, k) => (k === j ? withOptional(x, 'type', ev.target.value) : x)) })
                }
              />
              <button
                type="button"
                className={SMALL_BTN}
                aria-label={`Remove attribute ${j + 1}`}
                disabled={busy}
                onClick={() => patch(i, { attributes: e.attributes.filter((_, k) => k !== j) })}
              >
                ×
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className={SMALL_BTN}
              disabled={busy || e.attributes.length >= DESIGN_CAPS.attributes}
              data-testid={`design-board-entity-${i}-attr-add`}
              onClick={() => patch(i, { attributes: [...e.attributes, { name: '' }] })}
            >
              Add an attribute
            </button>
          </div>
          <label className="label-sm" htmlFor={`design-board-entity-${e.id}-resp`}>
            Responsibilities, one per line
          </label>
          <AutoText
            id={`design-board-entity-${e.id}-resp`}
            className={CELL}
            value={e.responsibilities.join('\n')}
            placeholder="lend a book to a reader"
            disabled={busy}
            data-testid={`design-board-entity-${i}-resp`}
            // Blank lines are kept while the learner types; the diagram never draws them.
            onChange={(ev) => patch(i, { responsibilities: ev.target.value.split('\n').slice(0, DESIGN_CAPS.responsibilities).map(capLine) })}
          />
          <StoryToggles
            stories={stories}
            picked={e.satisfies}
            label="Stories it serves"
            disabled={busy}
            testId={(id) => `design-board-entity-${i}-story-${id}`}
            onChange={(satisfies) => patch(i, { satisfies })}
          />
        </Panel>
      ))}
      <div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy || entities.length >= DESIGN_CAPS.entities}
          data-testid="design-board-entity-add"
          onClick={() => set([...entities, emptyEntity(entities)])}
        >
          Add an entity
        </button>
      </div>
    </div>
  );
}

export function RelationsCard({ design }: { design: DesignState }) {
  const { doc, write, busy } = design;
  const entities = doc.entities;
  const relations = doc.relations;
  const set = (next: DesignRelation[]) => write({ ...doc, relations: next });
  const patch = (i: number, p: Partial<DesignRelation>) => set(relations.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const setOptional = (i: number, key: 'fromCard' | 'toCard' | 'label', value: string) =>
    set(relations.map((r, k) => (k === i ? withOptional(r, key, value) : r)));
  const label = (id: string) => entities.find((e) => e.id === id)?.name.trim() || id;
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="design-board-relations">
      <SectionHead title="Relations" purpose="How the boxes connect, and how many of each sit at either end." />
      {entities.length < 1 && <p className="label-sm wrap">Add an entity first; a relation joins two of them.</p>}
      {relations.map((r, i) => (
        <Panel key={r.id} className="flex flex-wrap items-center gap-2 p-3" testId={`design-board-relation-${i}`}>
          <AssistantMark fields={design.assisted(`design/relation-${i + 1}`)} testId={`design-board-relation-${i}-touched`} />
          <SelectCell
            value={r.from}
            aria-label={`Relation ${i + 1} from`}
            disabled={busy}
            data-testid={`design-board-relation-${i}-from`}
            onChange={(ev) => patch(i, { from: ev.target.value })}
          >
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {label(e.id)}
              </option>
            ))}
          </SelectCell>
          <SelectCell
            // A 24px floor both ways (WCAG 2.5.8): "1" and "*" alone would leave it narrower than a fingertip.
            className="min-h-[24px] min-w-[52px]"
            value={r.fromCard ?? ''}
            aria-label={`Relation ${i + 1} cardinality at the from end`}
            disabled={busy}
            data-testid={`design-board-relation-${i}-from-card`}
            onChange={(ev) => setOptional(i, 'fromCard', ev.target.value)}
          >
            {CARDINALITIES.map((c) => (
              <option key={c} value={c}>
                {c || '—'}
              </option>
            ))}
          </SelectCell>
          <SelectCell
            value={r.kind}
            aria-label={`Relation ${i + 1} kind`}
            disabled={busy}
            data-testid={`design-board-relation-${i}-kind`}
            onChange={(ev) => patch(i, { kind: ev.target.value as RelationKind })}
          >
            {RELATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k} ({RELATION_HELP[k]})
              </option>
            ))}
          </SelectCell>
          <SelectCell
            // A 24px floor both ways (WCAG 2.5.8): "1" and "*" alone would leave it narrower than a fingertip.
            className="min-h-[24px] min-w-[52px]"
            value={r.toCard ?? ''}
            aria-label={`Relation ${i + 1} cardinality at the to end`}
            disabled={busy}
            data-testid={`design-board-relation-${i}-to-card`}
            onChange={(ev) => setOptional(i, 'toCard', ev.target.value)}
          >
            {CARDINALITIES.map((c) => (
              <option key={c} value={c}>
                {c || '—'}
              </option>
            ))}
          </SelectCell>
          <SelectCell
            value={r.to}
            aria-label={`Relation ${i + 1} to`}
            disabled={busy}
            data-testid={`design-board-relation-${i}-to`}
            onChange={(ev) => patch(i, { to: ev.target.value })}
          >
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {label(e.id)}
              </option>
            ))}
          </SelectCell>
          <input
            className={`${CELL} min-w-[120px] flex-1`}
            value={r.label ?? ''}
            maxLength={FIELD}
            placeholder="label, e.g. holds"
            aria-label={`Relation ${i + 1} label`}
            disabled={busy}
            data-testid={`design-board-relation-${i}-label`}
            onChange={(ev) => setOptional(i, 'label', ev.target.value)}
          />
          <button
            type="button"
            className={SMALL_BTN}
            disabled={busy}
            data-testid={`design-board-relation-${i}-remove`}
            onClick={() => set(relations.filter((_, k) => k !== i))}
          >
            Remove
          </button>
        </Panel>
      ))}
      <div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy || entities.length < 1 || relations.length >= DESIGN_CAPS.relations}
          data-testid="design-board-relation-add"
          onClick={() =>
            set([...relations, emptyRelation(relations, entities[0].id, (entities[1] ?? entities[0]).id)])
          }
        >
          Add a relation
        </button>
      </div>
    </div>
  );
}

export function NotesCard({ design }: { design: DesignState }) {
  const { doc, write, busy } = design;
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="design-board-notes-card">
      <SectionHead
        title="Notes"
        purpose="Anything else the design should say, in your own words."
        right={<AssistantMark fields={design.assisted('design/notes')} testId="design-board-notes-touched" />}
      />
      <Panel className="p-3">
        <AutoText
          className={`${CELL} w-full`}
          minRows={3}
          value={doc.notes ?? ''}
          maxLength={FIELD}
          aria-label="Design notes"
          placeholder="Assumptions, open questions, what you left out and why."
          disabled={busy}
          data-testid="design-board-notes"
          onChange={(ev) => write(withOptional(doc, 'notes', ev.target.value))}
        />
      </Panel>
    </div>
  );
}
