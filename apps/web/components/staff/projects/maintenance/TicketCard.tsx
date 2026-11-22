'use client';

/**
 * Step 2: the ticket the learner's change answers (`checks.ticket`).
 *
 * Its id, title and summary, and its acceptance lines: "Add a line" mints
 * the next `AC-` id and stops at the cap, and every field stops at its own.
 * The save sends `{ ticket }` through the builder's one task queue, with the
 * change request's switch and floor beside it while the server holds none
 * (a task still in the older format), which converts it. Before anything is
 * sent the ticket is held to the door's own rules: an acceptance id the
 * starting change request covers cannot be dropped, and the shared ticket
 * validator's sentence is said for anything else the door would refuse.
 * Each new answer for the task redraws the ticket with the server's words
 * while nothing is typed here (`useServerRedraw`).
 */
import { useState } from 'react';
import { CHANGE_CAPS, validateChangeTicket, type ChangeTicket, type DraftTaskView, type TaskMutationResult } from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { BuilderCard, SaveLine, useCardSave, useServerRedraw, type CardState } from '../requirements/BuilderCard';
import { changeBodyOf, nextAcceptanceId, ticketEditProblem, type MaintenanceTaskWrite } from './maintenance-builder-model';

const EMPTY_TICKET: ChangeTicket = { id: '', title: '', summary: '', acceptance: [] };

export function TicketCard({
  task,
  writeTask,
  starting,
  editable,
  state,
  onFocusCard,
  onSaved,
}: {
  task: DraftTaskView;
  writeTask: MaintenanceTaskWrite;
  /** The starting change request's bytes as the server holds them, or null while they are read. */
  starting: string | null;
  editable: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
}) {
  const saved = task.change?.ticket ?? EMPTY_TICKET;
  const [ticket, setTicket] = useState<ChangeTicket>(() => ({ ...saved, acceptance: saved.acceptance.map((one) => ({ ...one })) }));

  const save = useCardSave({
    label: 'Ticket',
    saveButton: 'Save the ticket',
    validate: () => {
      const covered = ticketEditProblem(ticket, starting);
      if (covered) return covered;
      try {
        validateChangeTicket(ticket);
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    },
    send: () => {
      const sent = { ...ticket, acceptance: ticket.acceptance.map((one) => ({ ...one })) };
      return writeTask((held) => (held ? { ticket: sent } : { ticket: sent, change: changeBodyOf(task) }));
    },
    onSaved,
  });
  // Each new answer redraws the ticket with the server's words while nothing is typed here.
  useServerRedraw(task, save.clean, (next) => {
    const held = next.change?.ticket ?? EMPTY_TICKET;
    setTicket({ ...held, acceptance: held.acceptance.map((one) => ({ ...one })) });
  });
  // What the learner's heading reads: the ticket being edited, or the saved one where nothing is editable.
  const heading = editable ? ticket : saved;
  const edit = (next: ChangeTicket) => {
    setTicket(next);
    save.changed();
  };
  const setLine = (at: number, line: string) =>
    edit({ ...ticket, acceptance: ticket.acceptance.map((one, i) => (i === at ? { ...one, line: line.slice(0, CHANGE_CAPS.acceptanceLine) } : one)) });

  return (
    <BuilderCard
      n={2}
      title="Ticket"
      purpose="The change the learner is asked to make: what it is called, why, and the acceptance lines their change request covers."
      state={state}
      testId="tdm-ticket"
      onFocusCard={onFocusCard}
      onLeave={() => {
        if (editable) save.saveSoon();
      }}
    >
      <p className="label-sm wrap" data-testid="tdm-ticket-heading">
        {heading.id.trim() && heading.title.trim()
          ? `Learners read it as ${heading.id}: ${heading.title}`
          : 'Learners read the ticket by its id and title once both are written.'}
      </p>
      <div className="tre-story">
        <label className="tre-labelled">
          <span className="label-sm">Ticket id</span>
          {editable ? (
            <input
              className="field tre-in"
              aria-label="Ticket id"
              value={ticket.id}
              maxLength={CHANGE_CAPS.ticketId}
              data-testid="tdm-ticket-id"
              onChange={(event) => edit({ ...ticket, id: event.target.value.slice(0, CHANGE_CAPS.ticketId) })}
            />
          ) : (
            <code className="tre-value mono">{saved.id}</code>
          )}
        </label>
        <label className="tre-labelled">
          <span className="label-sm">Title</span>
          {editable ? (
            <input
              className="field tre-in tre-in-wide"
              aria-label="Ticket title"
              value={ticket.title}
              maxLength={CHANGE_CAPS.ticketTitle}
              data-testid="tdm-ticket-title"
              onChange={(event) => edit({ ...ticket, title: event.target.value.slice(0, CHANGE_CAPS.ticketTitle) })}
            />
          ) : (
            <span className="tre-value wrap">{saved.title}</span>
          )}
        </label>
        <label className="tre-labelled">
          <span className="label-sm">Summary</span>
          {editable ? (
            <textarea
              className="field tre-ta"
              rows={3}
              aria-label="Ticket summary"
              value={ticket.summary}
              maxLength={CHANGE_CAPS.ticketSummary}
              data-testid="tdm-ticket-summary"
              onChange={(event) => edit({ ...ticket, summary: event.target.value.slice(0, CHANGE_CAPS.ticketSummary) })}
            />
          ) : (
            <span className="tre-value wrap">{saved.summary}</span>
          )}
        </label>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="label-sm">{`Acceptance lines, at most ${CHANGE_CAPS.acceptance}`}</span>
        {(editable ? ticket : saved).acceptance.length === 0 && <p className="purpose">No acceptance lines yet.</p>}
        {editable ? (
          ticket.acceptance.map((one, at) => (
            <div key={one.id} className="flex min-w-0 flex-wrap items-center gap-2" data-testid={`tdm-ticket-line-${at}`}>
              <code className="mono label-sm">{one.id}</code>
              <input
                className="field tre-in tre-in-wide min-w-0 flex-1"
                aria-label={`Acceptance line ${one.id}`}
                value={one.line}
                maxLength={CHANGE_CAPS.acceptanceLine}
                data-testid={`tdm-ticket-line-${at}-text`}
                onChange={(event) => setLine(at, event.target.value)}
              />
              <Button
                size="sm"
                variant="ghost"
                ariaLabel={`Remove ${one.id}`}
                testId={`tdm-ticket-line-${at}-remove`}
                onClick={() => edit({ ...ticket, acceptance: ticket.acceptance.filter((_, i) => i !== at) })}
              >
                Remove
              </Button>
            </div>
          ))
        ) : (
          <ul className="flex flex-col gap-1">
            {saved.acceptance.map((one) => (
              <li key={one.id} className="wrap">
                <code className="mono">{one.id}</code> {one.line}
              </li>
            ))}
          </ul>
        )}
      </div>

      {editable && (
        <div className="tre-save-row">
          <SaveLine save={save} testId="tdm-ticket-status" idle="Edits save when you leave the card." />
          <span className="tde-actions">
            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              disabled={ticket.acceptance.length >= CHANGE_CAPS.acceptance}
              testId="tdm-ticket-add-line"
              onClick={() => edit({ ...ticket, acceptance: [...ticket.acceptance, { id: nextAcceptanceId(ticket), line: '' }] })}
            >
              Add a line
            </Button>
            <Button
              size="sm"
              variant="secondary"
              busy={save.status === 'saving'}
              busyLabel="Saving…"
              testId="tdm-ticket-save"
              onClick={() => void save.saveNow()}
            >
              Save the ticket
            </Button>
          </span>
        </div>
      )}
    </BuilderCard>
  );
}
