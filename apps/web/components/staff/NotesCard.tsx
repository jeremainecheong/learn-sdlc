'use client';

/**
 * Notes for one class.
 *
 * A **mentor note** is quoted word for word by the mentor to every learner in
 * this class in that phase. On one laptop with no API key that is the only way
 * a class hears its own instructor rather than a model: "compare due dates
 * with `datetime.date.today()`" reaches thirty people without being typed
 * thirty times. A **lecture point** never reaches a model at all: it is a line
 * held for the next session.
 *
 * The routes are the ones that already exist: `GET`, `POST`, `PATCH` and
 * `DELETE` on `/instructor/notes`, every one of them narrowed to the caller's
 * own classes on the server. The card needs no other API.
 *
 * The card takes the class it writes to rather than picking one: it is mounted
 * on the class page, where the class is the subject of everything else on the
 * screen, and a second class picker there would be a second answer to a
 * question the page has already answered. It writes no project slug, because a
 * class's project is an assignment that can change under it; a note with no
 * project reaches the mentor whatever version the class is on.
 *
 * On the portal's own `exp-` tokens, like `StuckList` beside it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import type { InstructorNoteKind, InstructorNoteView, PhaseKey } from '@learnsdlc/shared';
import { INSTRUCTOR_NOTE_MAX, INSTRUCTOR_NOTE_MIN } from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { mentorApi } from '@/lib/api-mentor';
import { PHASE_KEYS, PHASE_META } from '@/lib/phase';
import { when } from '@/components/staff/primitives';

/**
 * What `NotesService.forMentor` carries into one reply: at most two, a note
 * for the learner's own phase before a note for every phase, newest first
 * inside each. Said on the card, because a teacher who writes six and hears
 * two would otherwise think the mentor ignored them.
 */
const MENTOR_QUOTE_SENTENCE =
  'The AI mentor reads these notes. It quotes at most two of them word for word in one reply, taking a note written for the phase the learner is in before a note written for every phase.';

const KIND_WORD: Record<InstructorNoteKind, string> = {
  mentor: 'Mentor note',
  lecture: 'Lecture point',
};

/** What the mentor does with a note of this kind, said under the form. */
const KIND_RULE: Record<InstructorNoteKind, string> = {
  mentor: 'Learners in this class read this word for word when they ask the mentor in that phase.',
  lecture: 'This one is for you. It is held for the next session and never reaches the mentor.',
};

/** Enough of a note to know which one is being asked about. */
const quoted = (text: string) => (text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text);

/**
 * What a teacher is asked before a note goes, in the page rather than in a
 * browser dialog, the same two-button question the project editor asks before
 * removing a task. The consequence is the note's own: a mentor note stops being
 * quoted to the class, a lecture point was never theirs to hear. The row is
 * deleted outright by `NotesService.remove`, so there is nothing to undo.
 */
const removeQuestion = (note: InstructorNoteView) =>
  note.kind === 'mentor'
    ? `Delete "${quoted(note.text)}"? Learners in this class stop hearing it from the mentor, and it cannot be brought back.`
    : `Delete "${quoted(note.text)}"? It is yours alone, held for the next session, and it cannot be brought back.`;

export function NotesCard({
  cohortId,
  phases = PHASE_KEYS,
}: {
  cohortId: string;
  /**
   * The phases the class works, which the phase select offers: the portal
   * passes its board's, else LearnSDLC's six.
   */
  phases?: readonly PhaseKey[];
}) {
  const [notes, setNotes] = useState<InstructorNoteView[] | null>(null);
  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [kind, setKind] = useState<InstructorNoteKind>('mentor');
  const [phaseKey, setPhaseKey] = useState<PhaseKey | ''>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);

  const load = useCallback(async () => {
    try {
      const rows = await mentorApi.notes({ cohortId });
      if (alive.current) {
        setNotes(rows);
        setError('');
      }
    } catch (err) {
      // A failed read must not read as a class with nothing to say, so the
      // list stays absent and the failure is what is on the screen.
      if (alive.current) setError(describeError(err, 'The notes for this class did not load.'));
    }
  }, [cohortId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const reset = () => {
    setForm(false);
    setEditing(null);
    setRemoving(null);
    setKind('mentor');
    setPhaseKey('');
    setText('');
    setError('');
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = text.trim();
    if (busy || body.length < INSTRUCTOR_NOTE_MIN) return;
    setBusy(true);
    setError('');
    try {
      if (editing) {
        await mentorApi.updateNote(editing, { kind, phaseKey: phaseKey || null, text: body });
      } else {
        await mentorApi.writeNote({
          kind,
          cohortId,
          phaseKey: phaseKey || null,
          projectSlug: null,
          text: body,
        });
      }
      if (!alive.current) return;
      reset();
      await load();
    } catch (err) {
      // The typed note is kept: it is the only copy of it there is.
      if (alive.current) setError(describeError(err, 'The note did not save. Try again.'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // A note the whole class reads is worth one question before it goes. It is
  // asked in the page, beneath the note it is about, so the answer follows the
  // Delete button in the tab order and nothing has to steal focus.
  const remove = async (note: InstructorNoteView) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await mentorApi.deleteNote(note.id);
      if (!alive.current) return;
      if (editing === note.id) reset();
      setRemoving(null);
      await load();
    } catch (err) {
      if (alive.current) setError(describeError(err, 'The note did not go. Try again.'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const edit = (note: InstructorNoteView) => {
    setRemoving(null);
    setEditing(note.id);
    setForm(true);
    setKind(note.kind);
    setPhaseKey(note.phaseKey ?? '');
    setText(note.text);
    setError('');
  };

  const rows = notes ?? [];
  const short = text.trim().length < INSTRUCTOR_NOTE_MIN;

  return (
    <section className="exp-panel" data-testid="notes-card" aria-labelledby="class-notes-heading">
      <header className="exp-section-heading">
        <div>
          <span className="exp-eyebrow">What this class hears from you</span>
          <h2 id="class-notes-heading">
            <MessageSquareText size={21} aria-hidden="true" />
            Notes for this class
          </h2>
          <p>One thing written once, said to everyone in this class.</p>
        </div>
        <button
          type="button"
          className="exp-button"
          onClick={() => (form ? reset() : setForm(true))}
          data-testid="note-write"
        >
          {form ? 'Close this form' : 'Write a note'}
        </button>
      </header>

      <p className="exp-caption" data-testid="notes-mentor-rule">
        {MENTOR_QUOTE_SENTENCE}
      </p>

      {error && (
        <p role="alert" className="exp-error" data-testid="notes-error">
          {error}
        </p>
      )}

      {form && (
        <form className="exp-form" onSubmit={save}>
          <label className="exp-field">
            Kind of note
            <select
              value={kind}
              disabled={busy}
              onChange={(event) => setKind(event.target.value as InstructorNoteKind)}
              data-testid="note-kind"
            >
              <option value="mentor">Mentor note</option>
              <option value="lecture">Lecture point</option>
            </select>
          </label>
          <label className="exp-field">
            Which phase
            <select
              value={phaseKey}
              disabled={busy}
              onChange={(event) => setPhaseKey(event.target.value as PhaseKey | '')}
              data-testid="note-phase"
            >
              <option value="">Every phase</option>
              {/* The class's phases, and a note's own phase while it is edited
                  even when the class's version no longer holds it. */}
              {PHASE_KEYS.filter((key) => phases.includes(key) || key === phaseKey).map((key) => (
                <option key={key} value={key}>
                  {PHASE_META[key].title}
                </option>
              ))}
            </select>
          </label>
          <label className="exp-field">
            The note
            <textarea
              value={text}
              rows={4}
              maxLength={INSTRUCTOR_NOTE_MAX}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              placeholder="One thing this class should hear"
              aria-describedby="note-kind-rule"
              data-testid="note-text"
            />
          </label>
          <p className="exp-caption" id="note-kind-rule" data-testid="note-kind-rule">
            {KIND_RULE[kind]} It applies to whatever project this class is on.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="exp-button exp-primary"
              disabled={busy || short}
              data-testid="note-save"
            >
              {busy ? 'Saving…' : editing ? 'Save the change' : 'Save the note'}
            </button>
            <button type="button" className="exp-button" onClick={reset} data-testid="note-cancel">
              Discard this note
            </button>
            <span className="exp-caption" data-testid="note-count">
              {text.trim().length} of {INSTRUCTOR_NOTE_MAX}
            </span>
            {short && (
              <span className="exp-caption">
                A note the class can act on needs at least 10 characters.
              </span>
            )}
          </div>
        </form>
      )}

      {notes === null ? (
        <p role="status">
          {error ? 'The notes for this class are unavailable.' : 'Reading the notes for this class…'}
        </p>
      ) : rows.length === 0 ? (
        <p data-testid="notes-empty">
          No notes for this class yet. A mentor note is quoted to every learner in it, and a lecture
          point is a line you keep for the next session.
        </p>
      ) : (
        <ul className="exp-list" data-testid="notes-list">
          {rows.map((note) => (
            <li key={note.id} data-testid={`note-row-${note.id}`}>
              <div>
                <strong>{note.text}</strong>
                <small>
                  {KIND_WORD[note.kind]}, {note.phaseKey ? PHASE_META[note.phaseKey].title : 'every phase'},
                  written by {note.authorName ?? 'a colleague'}, {when(note.createdAt)}
                </small>
                <span className="flex flex-wrap items-center gap-2 pt-2">
                  <button
                    type="button"
                    className="exp-button"
                    disabled={busy}
                    onClick={() => edit(note)}
                    aria-label={`Edit the note starting ${note.text.slice(0, 40)}`}
                    data-testid={`note-edit-${note.id}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="exp-button"
                    disabled={busy}
                    onClick={() => {
                      setError('');
                      setRemoving(note.id);
                    }}
                    aria-expanded={removing === note.id}
                    aria-label={`Delete the note starting ${note.text.slice(0, 40)}`}
                    data-testid={`note-delete-${note.id}`}
                  >
                    Delete
                  </button>
                </span>
                {removing === note.id && (
                  <div
                    className="exp-inline-note mt-2"
                    role="status"
                    data-testid={`note-delete-confirm-${note.id}`}
                  >
                    <div>
                      <span className="block">{removeQuestion(note)}</span>
                      <span className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="exp-button"
                          disabled={busy}
                          onClick={() => void remove(note)}
                          data-testid={`note-delete-yes-${note.id}`}
                        >
                          {busy ? 'Deleting…' : 'Delete it'}
                        </button>
                        <button
                          type="button"
                          className="exp-button"
                          onClick={() => setRemoving(null)}
                          data-testid={`note-delete-no-${note.id}`}
                        >
                          Keep it
                        </button>
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default NotesCard;
