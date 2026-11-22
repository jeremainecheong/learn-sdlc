'use client';

/**
 * The record of staff changes: every override, every budget change, with the
 * reason the person typed and their name against it. The learner sees the
 * same facts on their own pages, so this is the page an appeal is answered
 * from.
 */
import { pluralWord, type AuditEventView, type PhaseKey } from '@learnsdlc/shared';
import { Chip, EmptyState, Section, StatusSquare } from '@/components/ui';
import { PHASE_META, type StatusState } from '@/lib/phase';
import { sinceLabel, when } from '@/components/staff/primitives';

const isPhaseKey = (value: unknown): value is PhaseKey =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(PHASE_META, value);

/** The phase an override names, when its detail carries one. */
function phaseTitleOf(event: AuditEventView): string | null {
  const key = event.detail?.phaseKey;
  return isPhaseKey(key) ? PHASE_META[key].title : null;
}

/**
 * The task a per-task lever names: the title the teacher authored, else the key
 * the pack gave it. A phase with several tasks has several rows that would
 * otherwise read exactly alike, so this is what makes the trail answerable.
 */
function taskNameOf(event: AuditEventView): string | null {
  const title = event.detail?.taskTitle;
  if (typeof title === 'string' && title.trim()) return title.trim();
  const key = event.detail?.taskKey;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

/**
 * How many tasks one restored countersignature covers.
 *
 * A class import writes one `task.signoff` per learner rather than per task, so
 * that row carries `detail.tasks` and neither a phase nor a key. It is the only
 * writer of these three that names no single task.
 */
function restoredTaskCount(event: AuditEventView): number | null {
  const tasks = event.detail?.tasks;
  return Array.isArray(tasks) && tasks.length > 0 ? tasks.length : null;
}

/** A detail value that is non-empty text, trimmed; anything else is absent. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The class a row names, where the writer put its name in `action`. */
function namedClass(event: AuditEventView): string | null {
  const name = event.action;
  return typeof name === 'string' && name.trim() && name !== 'leave' ? name.trim() : null;
}

/**
 * What happened, as one sentence, and how loudly to draw it.
 *
 * `unnamed` is set only by the default arm, so a caller can keep the machine
 * key on the detail line rather than printing it as the sentence.
 */
export function describeAudit(event: AuditEventView): {
  title: string;
  state: StatusState;
  unnamed?: true;
} {
  const phase = phaseTitleOf(event);
  switch (event.event) {
    case 'phase.override': {
      const subject = phase ?? 'a phase';
      // A teacher's Pass is credit on the board, never a reviewed pass.
      if (event.action === 'pass') return { title: `Marked ${subject} as passed: credit awarded`, state: 'pass' };
      if (event.action === 'reopen') return { title: `Reopened ${subject}`, state: 'warn' };
      if (event.action === 'reset-workspace')
        return { title: `Reset the ${subject} workspace`, state: 'fail' };
      // The fourth lever. A reset clears the phase
      // back to the pack's own starting state, so it is drawn as loudly as a
      // reset workspace, and the release it deleted is in the row's detail.
      if (event.action === 'reset-phase')
        return { title: `Reset ${subject} to the start`, state: 'fail' };
      return { title: `Overrode ${subject}`, state: 'warn' };
    }
    case 'budget.override': {
      const budget = event.detail?.dailyTokenBudget;
      if (typeof budget === 'number')
        return { title: `Set the daily token budget to ${budget.toLocaleString()}`, state: 'warn' };
      return { title: 'Removed the token budget override', state: 'warn' };
    }
    case 'budget.default': {
      const budget = event.detail?.dailyTokenBudget;
      if (typeof budget === 'number')
        return {
          title: `Set the daily token budget for everyone to ${budget.toLocaleString()}`,
          state: 'warn',
        };
      return { title: 'Changed the daily token budget for everyone', state: 'warn' };
    }
    case 'admin.user.update':
      return { title: 'Updated the account', state: 'warn' };
    case 'admin.password.set':
      return { title: 'Set a new password', state: 'warn' };
    case 'account.claimed':
      return { title: 'Confirmed this address with Google', state: 'warn' };
    // Answering a stuck learner and writing a note for a class are
    // both help given rather than a grade changed, so neither is drawn as an
    // override: the answer and the note text are the reason line below.
    case 'stuck.answer': {
      const subject = phase ?? 'a phase';
      return { title: `Answered a stuck learner in ${subject}`, state: 'pass' };
    }
    case 'note.write': {
      const kind = event.action === 'lecture' ? 'lecture point' : 'note for the class';
      return { title: `Wrote a ${kind}`, state: 'now' };
    }
    case 'note.delete': {
      const kind = event.action === 'lecture' ? 'lecture point' : 'note for the class';
      return { title: `Deleted a ${kind}`, state: 'warn' };
    }
    // Reading a learner's whole project changes nothing about it,
    // so it is drawn as a thing that happened rather than as an override, but
    // it is the one route that hands an instructor the learner's own files, so
    // it is on the record like every other change in who can read their work.
    case 'dossier.read':
      return { title: 'Read the dossier', state: 'now' };
    // A learner opened the pack's own answer to
    // a phase they had already passed. It changes no score and no file; it is
    // on the record because a class needs to be able to say who has seen the
    // answer.
    case 'solution.read':
      return { title: 'Read the reference solution', state: 'now' };
    // A teacher opened a quiz's answer key. Drawn in
    // `solution.read`'s shape and for its reason: nothing was written and no
    // score moved, and an MCQ key *is* the passing answer, so who has seen one
    // is a question a class has to be able to answer. `warn` rather than `now`
    // because the actor is staff and the reader of this row is asking about
    // them: it is the one row here that a teacher leaves about themselves.
    case 'project.quiz-key': {
      const task = taskNameOf(event);
      return {
        title: task ? `Read the answer key for ${task}` : 'Read a quiz answer key',
        state: 'warn',
      };
    }
    // A learner took their whole project away as a git repository.
    // Actor and subject are the same person, and it is on the record for the
    // same reason a class export is: it is the one route that hands the whole
    // of their work out as a file.
    case 'repo.export':
      return { title: 'Downloaded their repository', state: 'now' };
    // A regrade writes one row per learner it
    // re-ran, plus one for the batch itself; the two dates and a view-as are
    // recorded because they are things done to a class or to a learner, not
    // because they change a grade.
    case 'regrade.start': {
      const subject = phase ?? 'a phase';
      const requested = event.detail?.requested;
      return {
        title:
          typeof requested === 'number'
            ? `Started a regrade of ${subject} for ${requested} ${pluralWord(requested, 'learner')}`
            : `Started a regrade of ${subject}`,
        state: 'warn',
      };
    }
    case 'phase.regrade': {
      const subject = phase ?? 'a phase';
      const from = event.detail?.from;
      const to = event.detail?.to;
      const title =
        typeof to === 'number' && typeof from === 'number'
          ? `Regraded ${subject}, ${from} to ${to}`
          : `Regraded ${subject}`;
      // A revision of a run a reset has ended (the
      // teacher's or the learner's own) keeps its new verdict and moves no
      // gate. The API says so on the row; the trail says it too, so a teacher
      // is not surprised that a regrade after a reset changed nothing.
      const run = event.detail?.run;
      if (typeof run === 'string' && run.trim()) return { title: `${title}, ${run.trim()}`, state: 'now' };
      return { title, state: 'pass' };
    }
    case 'instructor.view-as':
      return { title: "Looked at this learner's work, read only", state: 'now' };
    case 'cohort.schedule':
      return { title: 'Set the dates for this class', state: 'now' };
    // The row's reason is null and the words are in
    // detail.text, so the sentence has to carry the fact on its own.
    case 'instructor.note':
      return { title: 'Wrote to the learner', state: 'now' };
    // The three levers a teacher has over
    // one task of a split phase. Each moves a gate, so each is drawn as loudly
    // as the phase-wide lever it mirrors, a countersignature passes, a reopen
    // withdraws a pass, a reset clears the task back to the start.
    case 'task.signoff': {
      const task = taskNameOf(event);
      if (task)
        return {
          title: phase ? `Signed off ${task} in ${phase}` : `Signed off ${task}`,
          state: 'pass',
        };
      // The import's row, which names its tasks rather than a task. Its reason
      // is the sentence about where the countersignature came from.
      const count = restoredTaskCount(event);
      return {
        title:
          count === null ? 'Signed off a task' : `Signed off ${count} ${pluralWord(count, 'task')}`,
        state: 'pass',
      };
    }
    // Named the way the sign-off row names it, task and
    // phase, so a trail of the three levers reads as one vocabulary.
    case 'task.reopen': {
      const task = taskNameOf(event);
      return { title: task ? (phase ? `Reopened ${task} in ${phase}` : `Reopened ${task}`) : 'Reopened a task', state: 'warn' };
    }
    case 'task.reset': {
      const task = taskNameOf(event);
      return { title: task ? (phase ? `Reset ${task} in ${phase}` : `Reset ${task}`) : 'Reset a task', state: 'fail' };
    }
    // The rest of a learner's own trail. `auditLog` scopes a learner's list to
    // `subjectUserId = learner.id`, and most of these rows are written by the
    // learner's own requests rather than by a member of staff, so the moment
    // this list went on screen beside the evidence, a teacher started reading
    // them. `preview.start` and `preview.stop` are two rows a session and
    // dominate the newest twenty-five on anyone who is working.
    case 'preview.start':
      return { title: 'Started the live preview', state: 'now' };
    case 'preview.stop':
      return { title: 'Stopped the live preview', state: 'now' };
    case 'cohort.create': {
      const name = namedClass(event);
      return { title: name ? `Made the class ${name}` : 'Made a class', state: 'now' };
    }
    case 'cohort.join': {
      const name = namedClass(event);
      return { title: name ? `Joined ${name}` : 'Joined a class', state: 'now' };
    }
    case 'cohort.leave':
      return { title: 'Left their class', state: 'now' };
    case 'admin.cohort.owner':
      return { title: 'Was given this class to run', state: 'warn' };
    case 'cohort.export':
      return { title: 'Exported a class as a file', state: 'now' };
    case 'cohort.import': {
      const name = namedClass(event);
      return { title: name ? `Imported the class ${name}` : 'Imported a class', state: 'now' };
    }
    case 'account.import':
      return { title: 'Account created by a class import', state: 'now' };
    // The account holder's own three writes. A password changing is a change
    // in who can sign in as this person, which is why it leaves a row at all,
    // so it is drawn as one rather than as something that merely happened.
    case 'password.change':
      return { title: 'Changed their password', state: 'warn' };
    case 'password.reset':
      return { title: 'Reset their password', state: 'warn' };
    case 'account.delete':
      return { title: 'Asked for their account to be deleted', state: 'fail' };
    // A teacher's own authoring, one sentence per name
    // in `AUTHORING_AUDIT_EVENTS`. The details name a phase, a path or a
    // version where the writer recorded one, never file bytes or answers.
    case 'project.create': {
      const title = textOf(event.detail?.title);
      return { title: title ? `Made the project ${title}` : 'Made a project', state: 'now' };
    }
    case 'project.update':
      return { title: 'Changed the project’s details', state: 'now' };
    case 'project.tasks':
      return { title: phase ? `Changed the tasks of ${phase}` : 'Changed a phase’s tasks', state: 'now' };
    case 'project.validate':
      return { title: 'Checked the draft before publishing', state: 'now' };
    case 'project.publish': {
      const version = textOf(event.detail?.version) ?? textOf(event.action);
      return { title: version ? `Published version ${version}` : 'Published the project', state: 'pass' };
    }
    case 'project.archive':
      return { title: 'Archived the project', state: 'warn' };
    case 'project.draft': {
      const version = textOf(event.detail?.version) ?? textOf(event.action);
      return { title: version ? `Opened draft ${version}` : 'Opened a new draft', state: 'now' };
    }
    case 'cohort.project': {
      const title = textOf(event.detail?.projectTitle);
      const version = textOf(event.detail?.version);
      return {
        title: title ? `Set the class project to ${title}${version ? `, version ${version}` : ''}` : 'Set the class project',
        state: 'now',
      };
    }
    case 'project.phase': {
      // The Phases card's three doors write this row too, with `detail.change`;
      // an introduction rewrite carries none.
      const change = textOf(event.detail?.change);
      if (change === 'removed') return { title: `Removed ${phase ?? 'a phase'} from the draft`, state: 'now' };
      if (change === 'restored') return { title: `Put ${phase ?? 'a phase'} back in the draft`, state: 'now' };
      if (change === 'added') return { title: `Added ${phase ?? 'a phase'} to the draft`, state: 'now' };
      return { title: phase ? `Rewrote the introduction to ${phase}` : 'Rewrote a phase introduction', state: 'now' };
    }
    case 'project.interview':
      return { title: 'Changed the stakeholder interview', state: 'now' };
    case 'project.files': {
      const path = textOf(event.detail?.path);
      return {
        title: path ? `Replaced ${path}${phase ? ` in ${phase}` : ''}` : 'Replaced a project file',
        state: 'now',
      };
    }
    // Drawn like the quiz key's: nothing was written, and the reader of this
    // row is asking about the teacher who read the stakeholder's answers.
    case 'project.interview-read':
      return { title: 'Read the stakeholder interview’s answers', state: 'warn' };
    // A version exported as an archive.
    case 'project.exported': {
      const version = textOf(event.detail?.version) ?? textOf(event.action);
      return { title: version ? `Exported version ${version} as an archive` : 'Exported the project as an archive', state: 'warn' };
    }
    // The upload door, the seal and deep validation. The
    // details name a title, a path or a count where the writer recorded one,
    // never an archive's bytes or a sealed file's.
    case 'project.uploaded': {
      // The upload route writes the slug (action and detail.slug); the slug is minted from
      // the title, never taken from the archive.
      const slug = textOf(event.detail?.slug) ?? textOf(event.action);
      return { title: slug ? `Uploaded the project ${slug} as a draft` : 'Uploaded a project as a draft', state: 'now' };
    }
    // Drawn like the quiz key's: the bytes of a hidden test or a solution were read.
    case 'project.sealed-read': {
      const path = textOf(event.detail?.path);
      // A starter or shelf download is filed against no
      // project, with the archive's name as its action and no path.
      const archive = !path && event.targetId === null ? textOf(event.action) : null;
      if (archive === 'starter') return { title: 'Downloaded the starter archive', state: 'warn' };
      if (archive === 'shelf') return { title: 'Downloaded the shelf example', state: 'warn' };
      return { title: path ? `Read the sealed file ${path}` : 'Read a sealed file', state: 'warn' };
    }
    case 'project.deep-validation':
      return { title: 'Started deep validation of the draft', state: 'now' };
    // The boot moved a learner pinned to a version whose Requirements was
    // markdown onto the one where the story is a record. Written by the
    // platform, once, so the sentence names the versions and not a person's act.
    case 'enrolment.repin': {
      const from = textOf(event.detail?.from);
      const to = textOf(event.detail?.to);
      // A move off a retired written phase whose row could not be written: the
      // learner was not moved, and the detail line gives the reason.
      if (event.detail?.refused === true) {
        return { title: from && to ? `Not moved from version ${from} to ${to}` : 'Not moved to the new version', state: 'warn' };
      }
      return {
        title: from && to
          ? `Moved from version ${from} to ${to}, where the story is written in the story builder`
          : 'Moved to the version where the story is written in the story builder',
        state: 'now',
      };
    }
    // The boot left a learner on their version because the new one holds a
    // different set of phases. The reason, on the detail line, names the phase.
    case 'enrolment.repin.stranded':
      return { title: 'Left on their version', state: 'now' };
    // The same boot moved a class assigned that markdown version, so learners
    // who join from then on start on the story version.
    case 'cohort.project.repin': {
      const from = textOf(event.detail?.from);
      const to = textOf(event.detail?.to);
      return {
        title: from && to
          ? `Moved the class from version ${from} to ${to}, where the story is written in the story builder`
          : 'Moved the class to the version where the story is written in the story builder',
        state: 'now',
      };
    }
    // One row per learner of a batch.
    case 'class.bulk-signoff': {
      const task = taskNameOf(event);
      return { title: task ? `Signed off ${task} with the class batch` : 'Signed off a task with the class batch', state: 'pass' };
    }
    default:
      // A row this build has no sentence for still reads as a recorded change,
      // and the key it came with is kept on the detail line below rather than
      // printed here as English it is not.
      return { title: 'A recorded change', state: 'warn', unnamed: true };
  }
}

/** The line under the sentence: the reason if one was required, else what changed. */
function detailOf(event: AuditEventView, unnamed: boolean): string | null {
  // A row the sentence above could not name keeps its key here, where a key
  // belongs: the teacher can quote it, and it is not being passed off as
  // English.
  if (unnamed) return event.reason ? `${event.reason} Recorded as ${event.event}.` : `Recorded as ${event.event}.`;
  if (event.reason) return event.reason;
  if (event.event === 'admin.user.update' && event.action) return event.action;
  if (event.event === 'admin.password.set') return 'Earlier sessions were signed out.';
  // A note to a learner has no reason to give, the note itself is
  // the thing that was written, and it is in the detail rather than the reason.
  if (event.event === 'instructor.note' && typeof event.detail?.text === 'string')
    return event.detail.text;
  if (event.event === 'account.claimed')
    return 'The password was cleared and earlier sessions were signed out.';
  return null;
}

export function AuditList({
  events,
  title = 'Record of changes',
  purpose = 'Recorded changes on this learner, newest first. Historical settings keep their original values.',
  testId,
  showSubject = false,
  emptyBody = 'No staff change has been recorded here.',
}: {
  events: AuditEventView[];
  title?: string;
  purpose?: string;
  /** The section's test id; the list inside is always `audit-list`. */
  testId?: string;
  /** Name the learner each row is about, for a cohort-wide trail. */
  showSubject?: boolean;
  emptyBody?: string;
}) {
  return (
    <Section title={title} purpose={purpose} icon="clipboard" testId={testId}>
      {events.length === 0 ? (
        <EmptyState icon="clipboard" title="Nothing recorded yet" body={emptyBody} testId="audit-empty" />
      ) : (
        <ol className="m-0 flex list-none flex-col p-0" data-testid="audit-list">
          {events.map((event) => {
            const { title: sentence, state, unnamed } = describeAudit(event);
            const detail = detailOf(event, Boolean(unnamed));
            const actor = event.actorName ?? 'A member of staff';
            const by =
              showSubject && event.subjectName ? `By ${actor}, on ${event.subjectName}` : `By ${actor}`;
            const ago = sinceLabel(event.createdAt);
            return (
              <li
                key={event.id}
                className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 border-t-1.5 border-edge py-2.5 first:border-t-0"
                data-testid={`audit-row-${event.id}`}
              >
                <span className="inline-flex pt-[5px]">
                  <StatusSquare state={state} size={10} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="wrap text-[13px] font-semibold text-ink">{sentence}</span>
                  {detail && <span className="wrap text-[12.5px] leading-[1.45] text-ink2">{detail}</span>}
                  <span className="label-sm wrap">{by}</span>
                </span>
                <Chip className="shrink-0 whitespace-nowrap" title={when(event.createdAt)}>
                  <time dateTime={event.createdAt}>{ago === 'just now' ? ago : `${ago} ago`}</time>
                </Chip>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
