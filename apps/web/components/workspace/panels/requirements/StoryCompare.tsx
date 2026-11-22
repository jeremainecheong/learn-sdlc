'use client';

import type { ReactNode } from 'react';
import type { AcceptanceCriterion, Story } from './story';
import { tagLabel } from './StoryCard';
import { SECTION_LABEL, type SectionKey } from './storyChanges';

/**
 * One column of the Agentic before/after overlay: a story drawn field by field,
 * read-only, with the fields a proposal changes marked. The paths in `changed`
 * are the review projection's; `storyChanges.ts` reads them.
 */

type Tone = 'before' | 'after';

/** The words a mark says on each side: what will happen, and what did. */
const MARK: Record<Tone, { changed: string; added: string; removed: string; ghost: string }> = {
  before: { changed: 'Will change', added: '', removed: 'Will be removed', ghost: 'not in your story yet' },
  after: { changed: 'Changed', added: 'New', removed: '', ghost: 'removed by this proposal' },
};

function Mark({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip ${tone === 'after' ? 'apv-chip-new' : 'apv-chip-was'}`}>{children}</span>;
}

const SCALAR: Record<'title' | 'as-a' | 'i-want' | 'so-that' | 'notes', (story: Story) => string> = {
  title: story => story.title,
  'as-a': story => story.persona,
  'i-want': story => story.capability,
  'so-that': story => story.benefit,
  notes: story => story.notes,
};

const CLAUSES = [['given', 'Given'], ['when', 'When'], ['then', 'Then']] as const;

/**
 * One story, drawn as the column of one side. `other` is the story on the
 * opposite side (null where that side has none), so a criterion or an
 * out-of-scope line that exists on one side only is drawn as a dashed row on
 * the other. `sections` are the sections to draw, in order.
 */
export function StoryCompare({ story, other, changed, tone, sections }: {
  story: Story;
  other: Story | null;
  changed: ReadonlySet<string>;
  tone: Tone;
  sections: readonly SectionKey[];
}) {
  const words = MARK[tone];
  /** On the after side, an entry the other side lacks is new; on the before side, it is going. */
  const onlyHere = (index: number, list: (s: Story) => unknown[]) => other === null || index >= list(other).length;
  return <>
    {sections.map(key => {
      if (key === 'criteria') {
        const count = Math.max(story.criteria.length, other?.criteria.length ?? 0);
        return <div className="apv-section" key={key}>
          <div className="apv-sec-head"><span className="label-sm font-medium">{SECTION_LABEL[key]}</span><span className="label-sm">{story.criteria.length} {story.criteria.length === 1 ? 'criterion' : 'criteria'}</span></div>
          {count === 0 ? <div className="field apv-ro"><span className="apv-muted">no criteria</span></div>
            : <ul className="apv-crits">{Array.from({ length: count }, (_, index) => {
              const criterion = story.criteria[index];
              const id = criterion?.id ?? other?.criteria[index]?.id ?? `AC-${index + 1}`;
              if (!criterion) return <li key={index} className="apv-crit apv-ghost"><span className="mono apv-ac">{id}</span><span className="apv-muted">{words.ghost}</span></li>;
              return <Criterion key={index} criterion={criterion} n={index + 1} tone={tone} changed={changed} only={onlyHere(index, s => s.criteria)} />;
            })}</ul>}
        </div>;
      }
      if (key === 'scope') {
        const count = Math.max(story.scopeExclusions.length, other?.scopeExclusions.length ?? 0);
        return <div className="apv-section" key={key}>
          <div className="apv-sec-head"><span className="label-sm font-medium">{SECTION_LABEL[key]}</span></div>
          <div className="field apv-ro apv-excl-box">{count === 0 ? <span className="apv-muted">no exclusions</span> : Array.from({ length: count }, (_, index) => {
            const line = story.scopeExclusions[index];
            if (line === undefined) return <div key={index} className="apv-excl apv-excl-ghost"><span className="apv-muted">{words.ghost}</span></div>;
            const only = onlyHere(index, s => s.scopeExclusions);
            const mark = only ? (tone === 'after' ? words.added : words.removed) : changed.has(`story/scope/${index + 1}`) ? words.changed : '';
            return <div key={index} className={`apv-excl ${mark ? (tone === 'after' ? 'apv-new' : 'apv-was') : ''}`}>
              <span>{line.trim() || <span className="apv-muted">an empty line</span>}</span>{mark && <Mark tone={tone}>{mark}</Mark>}
            </div>;
          })}</div>
        </div>;
      }
      const value = SCALAR[key](story);
      const isChanged = changed.has(`story/${key}`);
      return <div className="apv-section" key={key}>
        <div className="apv-sec-head"><span className="label-sm font-medium">{SECTION_LABEL[key]}</span>{isChanged && <Mark tone={tone}>{words.changed}</Mark>}</div>
        <div className={`field apv-ro ${isChanged ? (tone === 'after' ? 'apv-changed' : 'apv-was') : ''}`}>{value.trim() ? value : <span className="apv-muted">Not written</span>}</div>
      </div>;
    })}
  </>;
}

function Criterion({ criterion, n, tone, changed, only }: { criterion: AcceptanceCriterion; n: number; tone: Tone; changed: ReadonlySet<string>; only: boolean }) {
  const words = MARK[tone];
  const at = (field: string) => changed.has(`story/ac-${n}/${field}`);
  const any = at('given') || at('when') || at('then') || at('tag');
  const mark = only ? (tone === 'after' ? words.added : words.removed) : any ? words.changed : '';
  const marked = mark ? (tone === 'after' ? (only ? 'apv-new' : 'apv-changed') : 'apv-was') : '';
  return <li className={`apv-crit ${marked}`}>
    <span className="mono apv-ac">{criterion.id}</span>
    <div className="apv-gwt-rows">{CLAUSES.map(([field, word]) => <div key={field} className={`apv-gwt ${!only && at(field) ? 'apv-gwt-changed' : ''}`}>
      <span className="label-sm font-semibold text-muted">{word}</span><span>{criterion[field].trim() || <span className="apv-muted">not written</span>}</span>
    </div>)}</div>
    <span className="apv-crit-side"><span className={`chip ${!only && at('tag') ? 'apv-tag-changed' : ''}`}>{tagLabel(criterion.tag)}</span>{mark && <Mark tone={tone}>{mark}</Mark>}</span>
  </li>;
}
