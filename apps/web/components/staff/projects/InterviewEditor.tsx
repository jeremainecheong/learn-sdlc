'use client';

/**
 * The stakeholder interview, written whole.
 *
 * A persona and the facts they know are one document, so the form edits the
 * whole brief and saves it in one `interview.replace`. The caps are the
 * contract's, which are the content loader's own, so a brief this form
 * lets through is one the door and the loader both keep; the door still
 * decides, and its refusal is printed word for word.
 *
 * Accessibility: every input has a label, each fact is a `fieldset`
 * with its own `legend`, and every error is tied to its field by
 * `aria-describedby` and marked `aria-invalid`.
 */
import { useId, useState } from 'react';
import type { InterviewBody, InterviewFactBody } from '@learnsdlc/shared';
import {
  INTERVIEW_ANSWER_MAX,
  INTERVIEW_FACT_ID_PATTERN,
  INTERVIEW_KEYWORDS_MAX,
  INTERVIEW_KEYWORD_MAX,
  INTERVIEW_LINE_MAX,
  INTERVIEW_MAX_FACTS,
  INTERVIEW_MAX_TURNS_CAP,
  INTERVIEW_MAX_TURNS_MIN,
  INTERVIEW_PERSONA_NAME_MAX,
  INTERVIEW_PERSONA_ROLE_MAX,
  INTERVIEW_TOPIC_MAX,
} from '@learnsdlc/shared';
import { Button, Notice } from '@/components/ui';

/** A brief with nothing in it yet: one blank fact, the limits at a sensible start. */
export function emptyInterview(): InterviewBody {
  return {
    persona: { name: '', role: '' },
    opening: '',
    unknownReply: '',
    refusal: '',
    maxTurns: 10,
    factsExpected: 1,
    facts: [{ id: 'f1', topic: '', keywords: [], answer: '' }],
  };
}

/** The next free fact id, `f<n>`. */
function nextFactId(facts: InterviewFactBody[]): string {
  const taken = new Set(facts.map((one) => one.id));
  let n = facts.length + 1;
  while (taken.has(`f${n}`)) n += 1;
  return `f${n}`;
}

/** Keywords as a teacher types them: separated by commas. */
function parseKeywords(text: string): string[] {
  return text
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean);
}

/**
 * What is wrong with the brief, by field id, in sentences. Empty when the
 * form would send it. The door checks the same rules again.
 */
function interviewErrors(body: InterviewBody): Record<string, string> {
  const errors: Record<string, string> = {};
  const blank = (value: string) => !value.trim();
  if (blank(body.persona.name)) errors['persona-name'] = "Give the stakeholder's name.";
  if (blank(body.persona.role)) errors['persona-role'] = "Say what the stakeholder's role is.";
  if (blank(body.opening)) errors.opening = 'Write what the stakeholder says first.';
  if (blank(body.unknownReply)) errors['unknown-reply'] = 'Write what the stakeholder says about something the facts do not cover.';
  if (blank(body.refusal)) errors.refusal = 'Write what the stakeholder says when asked to write the artefact.';
  if (
    !Number.isInteger(body.maxTurns) ||
    body.maxTurns < INTERVIEW_MAX_TURNS_MIN ||
    body.maxTurns > INTERVIEW_MAX_TURNS_CAP
  ) {
    errors['max-turns'] = `Allow from ${INTERVIEW_MAX_TURNS_MIN} to ${INTERVIEW_MAX_TURNS_CAP} questions.`;
  }
  if (!Number.isInteger(body.factsExpected) || body.factsExpected < 1 || body.factsExpected > body.facts.length) {
    errors['facts-expected'] = `Choose from 1 to ${body.facts.length}, the number of facts.`;
  }
  const ids = new Set<string>();
  body.facts.forEach((fact, index) => {
    const at = `fact-${index}`;
    if (!INTERVIEW_FACT_ID_PATTERN.test(fact.id)) {
      errors[`${at}-id`] = 'Use 1 to 16 letters, digits, hyphens or underscores.';
    } else if (ids.has(fact.id)) {
      errors[`${at}-id`] = 'Another fact already uses this id.';
    }
    ids.add(fact.id);
    if (blank(fact.topic)) errors[`${at}-topic`] = 'Say what this fact settles.';
    if (fact.keywords.length === 0) {
      errors[`${at}-keywords`] = 'Give at least one word a learner would ask with.';
    } else if (fact.keywords.length > INTERVIEW_KEYWORDS_MAX) {
      errors[`${at}-keywords`] = `Use at most ${INTERVIEW_KEYWORDS_MAX} keywords.`;
    } else if (fact.keywords.some((one) => one.length > INTERVIEW_KEYWORD_MAX)) {
      errors[`${at}-keywords`] = `Keep each keyword to ${INTERVIEW_KEYWORD_MAX} characters.`;
    }
    if (blank(fact.answer)) errors[`${at}-answer`] = 'Write what the stakeholder answers.';
  });
  return errors;
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="label-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="label-sm wrap">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="label-sm wrap text-fail" data-testid={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The ids an input is described by: its hint, and its error when it has one. */
function describedBy(id: string, error: string | undefined, hint = false): string | undefined {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

const INPUT = 'field w-full min-w-0';

export function InterviewEditor({
  initial,
  busy,
  error,
  onSave,
  onCancel,
}: {
  /** The brief as `interview.read` answered it, or `emptyInterview()` for a new one. */
  initial: InterviewBody;
  busy: boolean;
  /** The door's refusal, word for word, or ''. */
  error: string;
  onSave: (body: InterviewBody) => void;
  onCancel: () => void;
}) {
  const base = useId().replace(/:/g, '');
  const [body, setBody] = useState<InterviewBody>(initial);
  const [keywordText, setKeywordText] = useState<string[]>(() =>
    initial.facts.map((fact) => fact.keywords.join(', ')),
  );
  const [shown, setShown] = useState<Record<string, string>>({});
  const id = (field: string) => `${base}-interview-${field}`;
  const err = (field: string) => shown[field];

  const set = (patch: Partial<InterviewBody>) => setBody((was) => ({ ...was, ...patch }));
  const setFact = (index: number, patch: Partial<InterviewFactBody>) =>
    setBody((was) => ({
      ...was,
      facts: was.facts.map((fact, at) => (at === index ? { ...fact, ...patch } : fact)),
    }));

  const addFact = () => {
    if (body.facts.length >= INTERVIEW_MAX_FACTS) return;
    setBody((was) => ({
      ...was,
      facts: [...was.facts, { id: nextFactId(was.facts), topic: '', keywords: [], answer: '' }],
    }));
    setKeywordText((was) => [...was, '']);
  };

  const removeFact = (index: number) => {
    if (body.facts.length <= 1) return;
    setBody((was) => {
      const facts = was.facts.filter((_, at) => at !== index);
      return { ...was, facts, factsExpected: Math.min(was.factsExpected, facts.length) };
    });
    setKeywordText((was) => was.filter((_, at) => at !== index));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: InterviewBody = {
      ...body,
      facts: body.facts.map((fact, index) => ({ ...fact, keywords: parseKeywords(keywordText[index] ?? '') })),
    };
    const found = interviewErrors(next);
    setShown(found);
    if (Object.keys(found).length > 0) {
      const first = Object.keys(found)[0];
      document.getElementById(id(first))?.focus();
      return;
    }
    onSave(next);
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={submit}
      noValidate
      aria-describedby={error ? id('refused') : undefined}
      data-testid="interview-editor"
    >
      {error && (
        <Notice tone="fail" role="alert" testId="interview-editor-error">
          <span id={id('refused')}>{error}</span>
        </Notice>
      )}

      <fieldset className="flex min-w-0 flex-col gap-2 rounded-ctl border-1.5 border-edge p-3">
        <legend className="px-1 text-[13px] font-semibold text-ink">The stakeholder</legend>
        <Field id={id('persona-name')} label="Name" error={err('persona-name')}>
          <input
            id={id('persona-name')}
            className={INPUT}
            value={body.persona.name}
            maxLength={INTERVIEW_PERSONA_NAME_MAX}
            aria-invalid={Boolean(err('persona-name')) || undefined}
            aria-describedby={describedBy(id('persona-name'), err('persona-name'))}
            data-testid="interview-persona-name"
            onChange={(e) => set({ persona: { ...body.persona, name: e.target.value } })}
          />
        </Field>
        <Field id={id('persona-role')} label="Role" error={err('persona-role')}>
          <input
            id={id('persona-role')}
            className={INPUT}
            value={body.persona.role}
            maxLength={INTERVIEW_PERSONA_ROLE_MAX}
            aria-invalid={Boolean(err('persona-role')) || undefined}
            aria-describedby={describedBy(id('persona-role'), err('persona-role'))}
            data-testid="interview-persona-role"
            onChange={(e) => set({ persona: { ...body.persona, role: e.target.value } })}
          />
        </Field>
      </fieldset>

      <Field id={id('opening')} label="What they say first" error={err('opening')}>
        <textarea
          id={id('opening')}
          className={INPUT}
          rows={2}
          value={body.opening}
          maxLength={INTERVIEW_LINE_MAX}
          aria-invalid={Boolean(err('opening')) || undefined}
          aria-describedby={describedBy(id('opening'), err('opening'))}
          data-testid="interview-opening"
          onChange={(e) => set({ opening: e.target.value })}
        />
      </Field>
      <Field
        id={id('unknown-reply')}
        label="What they say when the facts do not cover a question"
        error={err('unknown-reply')}
      >
        <textarea
          id={id('unknown-reply')}
          className={INPUT}
          rows={2}
          value={body.unknownReply}
          maxLength={INTERVIEW_LINE_MAX}
          aria-invalid={Boolean(err('unknown-reply')) || undefined}
          aria-describedby={describedBy(id('unknown-reply'), err('unknown-reply'))}
          data-testid="interview-unknown-reply"
          onChange={(e) => set({ unknownReply: e.target.value })}
        />
      </Field>
      <Field id={id('refusal')} label="What they say when asked to write the artefact" error={err('refusal')}>
        <textarea
          id={id('refusal')}
          className={INPUT}
          rows={2}
          value={body.refusal}
          maxLength={INTERVIEW_LINE_MAX}
          aria-invalid={Boolean(err('refusal')) || undefined}
          aria-describedby={describedBy(id('refusal'), err('refusal'))}
          data-testid="interview-refusal"
          onChange={(e) => set({ refusal: e.target.value })}
        />
      </Field>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          id={id('max-turns')}
          label="Questions a learner may ask"
          error={err('max-turns')}
          hint={`From ${INTERVIEW_MAX_TURNS_MIN} to ${INTERVIEW_MAX_TURNS_CAP}.`}
        >
          <input
            id={id('max-turns')}
            className={INPUT}
            type="number"
            min={INTERVIEW_MAX_TURNS_MIN}
            max={INTERVIEW_MAX_TURNS_CAP}
            value={Number.isFinite(body.maxTurns) ? body.maxTurns : ''}
            aria-invalid={Boolean(err('max-turns')) || undefined}
            aria-describedby={describedBy(id('max-turns'), err('max-turns'), true)}
            data-testid="interview-max-turns"
            onChange={(e) => set({ maxTurns: Number(e.target.value) })}
          />
        </Field>
        <Field
          id={id('facts-expected')}
          label="Facts worth settling before the story"
          error={err('facts-expected')}
          hint="From 1 to the number of facts."
        >
          <input
            id={id('facts-expected')}
            className={INPUT}
            type="number"
            min={1}
            max={body.facts.length}
            value={Number.isFinite(body.factsExpected) ? body.factsExpected : ''}
            aria-invalid={Boolean(err('facts-expected')) || undefined}
            aria-describedby={describedBy(id('facts-expected'), err('facts-expected'), true)}
            data-testid="interview-facts-expected"
            onChange={(e) => set({ factsExpected: Number(e.target.value) })}
          />
        </Field>
      </div>

      <ol className="m-0 flex list-none flex-col gap-3 p-0" data-testid="interview-facts">
        {body.facts.map((fact, index) => {
          const at = `fact-${index}`;
          return (
            <li key={index}>
              <fieldset
                className="flex min-w-0 flex-col gap-2 rounded-ctl border-1.5 border-edge p-3"
                data-testid={`interview-fact-${index}`}
              >
                <legend className="px-1 text-[13px] font-semibold text-ink">{`Fact ${index + 1}`}</legend>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[140px_minmax(0,1fr)]">
                  <Field id={id(`${at}-id`)} label="Id" error={err(`${at}-id`)}>
                    <input
                      id={id(`${at}-id`)}
                      className={INPUT}
                      value={fact.id}
                      maxLength={16}
                      aria-invalid={Boolean(err(`${at}-id`)) || undefined}
                      aria-describedby={describedBy(id(`${at}-id`), err(`${at}-id`))}
                      data-testid={`interview-fact-${index}-id`}
                      onChange={(e) => setFact(index, { id: e.target.value })}
                    />
                  </Field>
                  <Field id={id(`${at}-topic`)} label="What it settles" error={err(`${at}-topic`)}>
                    <input
                      id={id(`${at}-topic`)}
                      className={INPUT}
                      value={fact.topic}
                      maxLength={INTERVIEW_TOPIC_MAX}
                      aria-invalid={Boolean(err(`${at}-topic`)) || undefined}
                      aria-describedby={describedBy(id(`${at}-topic`), err(`${at}-topic`))}
                      data-testid={`interview-fact-${index}-topic`}
                      onChange={(e) => setFact(index, { topic: e.target.value })}
                    />
                  </Field>
                </div>
                <Field
                  id={id(`${at}-keywords`)}
                  label="Words a learner would ask with"
                  error={err(`${at}-keywords`)}
                  hint={`Separated by commas: 1 to ${INTERVIEW_KEYWORDS_MAX}.`}
                >
                  <input
                    id={id(`${at}-keywords`)}
                    className={INPUT}
                    value={keywordText[index] ?? ''}
                    aria-invalid={Boolean(err(`${at}-keywords`)) || undefined}
                    aria-describedby={describedBy(id(`${at}-keywords`), err(`${at}-keywords`), true)}
                    data-testid={`interview-fact-${index}-keywords`}
                    onChange={(e) =>
                      setKeywordText((was) => was.map((one, i) => (i === index ? e.target.value : one)))
                    }
                  />
                </Field>
                <Field id={id(`${at}-answer`)} label="What the stakeholder answers" error={err(`${at}-answer`)}>
                  <textarea
                    id={id(`${at}-answer`)}
                    className={INPUT}
                    rows={3}
                    value={fact.answer}
                    maxLength={INTERVIEW_ANSWER_MAX}
                    aria-invalid={Boolean(err(`${at}-answer`)) || undefined}
                    aria-describedby={describedBy(id(`${at}-answer`), err(`${at}-answer`))}
                    data-testid={`interview-fact-${index}-answer`}
                    onChange={(e) => setFact(index, { answer: e.target.value })}
                  />
                </Field>
                {body.facts.length > 1 && (
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      ariaLabel={`Remove fact ${index + 1}`}
                      testId={`interview-fact-${index}-remove`}
                      onClick={() => removeFact(index)}
                    >
                      Remove this fact
                    </Button>
                  </div>
                )}
              </fieldset>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          disabled={body.facts.length >= INTERVIEW_MAX_FACTS}
          reason={
            body.facts.length >= INTERVIEW_MAX_FACTS
              ? `An interview holds at most ${INTERVIEW_MAX_FACTS} facts.`
              : undefined
          }
          testId="interview-fact-add"
          onClick={addFact}
        >
          Add a fact
        </Button>
        <Button type="submit" size="sm" busy={busy} busyLabel="Saving…" testId="interview-save">
          Save the interview
        </Button>
        <Button size="sm" variant="ghost" testId="interview-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
