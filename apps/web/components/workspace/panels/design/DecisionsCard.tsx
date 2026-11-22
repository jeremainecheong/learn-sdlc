'use client';

/**
 * The decisions behind the design, one record each: what was decided and
 * what forced it, the option not taken, why this one won, what it costs and
 * what follows from it, whether anybody has accepted it, and the stories it
 * serves.
 */
import { DESIGN_CAPS, DESIGN_DECISION_STATUSES, decidedOn, type DesignDecision, type DesignDecisionStatus } from '@learnsdlc/shared';
import { Chip, Panel, SectionHead } from '@/components/ui';
import { AutoText, CELL, Line, SelectCell, capLine } from './cells';
import { AssistantMark, SMALL_BTN, StoryToggles, optional } from './BoardCards';
import { emptyDecision } from './model';
import type { DesignState } from './useDesign';

const STATUS_LABEL: Record<DesignDecisionStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  superseded: 'Superseded',
};
const STATUS_TONE: Record<DesignDecisionStatus, 'pass' | 'neutral' | 'warn'> = {
  proposed: 'neutral',
  accepted: 'pass',
  superseded: 'warn',
};

/**
 * The decisions with the one at `index` removed, and every "superseded by"
 * link that named it cleared: a link to a decision that is gone points at
 * nothing, so it leaves the record rather than dangling in it.
 */
export function withoutDecision(decisions: DesignDecision[], index: number): DesignDecision[] {
  const gone = decisions[index]?.id;
  return decisions
    .filter((_, k) => k !== index)
    .map((d) => {
      if (gone === undefined || d.supersededBy !== gone) return d;
      const { supersededBy: _link, ...rest } = d;
      return rest;
    });
}

/** The decision with its consequences as typed: blank lines kept while the learner types, no key once the box is empty. */
export function withConsequences(d: DesignDecision, text: string): DesignDecision {
  const { consequences: _gone, ...rest } = d;
  const lines = text === '' ? [] : text.split('\n').slice(0, DESIGN_CAPS.consequences).map(capLine);
  return lines.length ? { ...rest, consequences: lines } : rest;
}


export function DecisionsCard({ design }: { design: DesignState }) {
  const { doc, write, setDecisionStatus, stories, busy } = design;
  const decisions = doc.decisions;
  const set = (next: DesignDecision[]) => write({ ...doc, decisions: next });
  const replace = (i: number, next: DesignDecision) => set(decisions.map((d, k) => (k === i ? next : d)));
  const patch = (i: number, p: Partial<DesignDecision>) => replace(i, { ...decisions[i], ...p });
  const setOptional = (i: number, key: 'context' | 'supersededBy', value: string) => {
    const { [key]: _gone, ...rest } = decisions[i];
    replace(i, { ...rest, ...optional(key, value) } as DesignDecision);
  };
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="design-decisions">
      <SectionHead
        title="Decisions"
        purpose="One record each: what forced the decision, the option not taken, why this one won, what it costs, and whether anybody has accepted it."
      />
      {decisions.length === 0 && <p className="label-sm wrap">No decisions yet. Record the first choice your design rests on.</p>}
      {decisions.map((d, i) => {
        const id = (field: string) => `design-decision-${i}-${field}`;
        const when = decidedOn(d.decidedAt);
        const others = decisions.filter((x) => x.id !== d.id);
        return (
          <Panel key={d.id} className="flex flex-col" testId={`design-decision-${i}`}>
            <header className="flex flex-wrap items-center gap-2 border-b-1.5 border-edge px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
                {d.title.trim() || 'Untitled decision'}
              </span>
              <Chip tone={STATUS_TONE[d.status]} className="shrink-0 whitespace-nowrap">
                {STATUS_LABEL[d.status]}
                {d.status === 'accepted' && when ? `, ${when}` : ''}
              </Chip>
              <SelectCell
                className="h-6 w-auto shrink-0 rounded-chip border-1.5 border-edge2 !py-0 !pl-2 text-[11.5px] font-medium text-ink2"
                value={d.status}
                aria-label={`Status of decision ${i + 1}`}
                disabled={busy}
                data-testid={id('status')}
                onChange={(e) => setDecisionStatus(i, e.target.value as DesignDecisionStatus)}
              >
                {DESIGN_DECISION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </SelectCell>
              <button type="button" className={SMALL_BTN} disabled={busy} data-testid={id('remove')} onClick={() => set(withoutDecision(decisions, i))}>
                Remove
              </button>
            </header>
            <div className="flex flex-col gap-2 px-3 py-2.5">
              <AssistantMark
                fields={design.assisted(`design/decision-${i + 1}`, ['title', 'choice', 'alternative', 'rationale', 'trade-off', 'context', 'consequences', 'status', 'superseded-by', 'satisfies'])}
                testId={id('touched')}
              />
              <Line label="Title" htmlFor={id('title')}>
                <input
                  id={id('title')}
                  className={CELL}
                  value={d.title}
                  maxLength={DESIGN_CAPS.fieldChars}
                  placeholder="Where the books are stored"
                  disabled={busy}
                  data-testid={id('title')}
                  onChange={(e) => patch(i, { title: e.target.value })}
                />
              </Line>
              <Line label="Context" htmlFor={id('context')}>
                <AutoText
                  id={id('context')}
                  className={CELL}
                  value={d.context ?? ''}
                  maxLength={DESIGN_CAPS.fieldChars}
                  placeholder="the shelf has to survive a restart, and the class machine has no database"
                  disabled={busy}
                  data-testid={id('context')}
                  onChange={(e) => setOptional(i, 'context', e.target.value)}
                />
              </Line>
              <Line label="Choice" htmlFor={id('choice')}>
                <AutoText
                  id={id('choice')}
                  className={CELL}
                  value={d.choice}
                  maxLength={DESIGN_CAPS.fieldChars}
                  placeholder="store the books in one JSON file"
                  disabled={busy}
                  data-testid={id('choice')}
                  onChange={(e) => patch(i, { choice: e.target.value })}
                />
              </Line>
              <Line label="Alternative" htmlFor={id('alternative')}>
                <AutoText
                  id={id('alternative')}
                  className={CELL}
                  value={d.alternative}
                  maxLength={DESIGN_CAPS.fieldChars}
                  placeholder="a database server"
                  disabled={busy}
                  data-testid={id('alternative')}
                  onChange={(e) => patch(i, { alternative: e.target.value })}
                />
              </Line>
              <Line label="Rationale" htmlFor={id('rationale')}>
                <AutoText
                  id={id('rationale')}
                  className={CELL}
                  value={d.rationale}
                  maxLength={DESIGN_CAPS.fieldChars}
                  placeholder="one file is enough for one shelf"
                  disabled={busy}
                  data-testid={id('rationale')}
                  onChange={(e) => patch(i, { rationale: e.target.value })}
                />
              </Line>
              <Line label="Trade-off" htmlFor={id('tradeoff')}>
                <AutoText
                  id={id('tradeoff')}
                  className={CELL}
                  value={d.tradeOff}
                  maxLength={DESIGN_CAPS.fieldChars}
                  placeholder="two writers at once need a lock"
                  disabled={busy}
                  data-testid={id('tradeoff')}
                  onChange={(e) => patch(i, { tradeOff: e.target.value })}
                />
              </Line>
              <Line label="Consequences, one per line" htmlFor={id('consequences')}>
                <AutoText
                  id={id('consequences')}
                  className={CELL}
                  value={(d.consequences ?? []).join('\n')}
                  placeholder="the data file can be read in an editor"
                  disabled={busy}
                  data-testid={id('consequences')}
                  onChange={(e) => replace(i, withConsequences(d, e.target.value))}
                />
              </Line>
              {d.status === 'superseded' && (
                <Line label="Superseded by" htmlFor={id('superseded-by')}>
                  <SelectCell
                    id={id('superseded-by')}
                    value={d.supersededBy ?? ''}
                    disabled={busy}
                    data-testid={id('superseded-by')}
                    onChange={(e) => setOptional(i, 'supersededBy', e.target.value)}
                  >
                    <option value="">Not named yet</option>
                    {others.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title.trim() ? `${x.id}: ${x.title.trim()}` : x.id}
                      </option>
                    ))}
                  </SelectCell>
                </Line>
              )}
              <StoryToggles
                stories={stories}
                picked={d.satisfies}
                label="Stories it serves"
                disabled={busy}
                testId={(storyId) => `design-decision-${i}-story-${storyId}`}
                onChange={(satisfies) => patch(i, { satisfies })}
              />
            </div>
          </Panel>
        );
      })}
      <div>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy || decisions.length >= DESIGN_CAPS.decisions}
          data-testid="design-decision-add"
          onClick={() => set([...decisions, emptyDecision(decisions)])}
        >
          Add a decision
        </button>
      </div>
    </div>
  );
}
