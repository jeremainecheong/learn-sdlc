import { BadRequestException } from '@nestjs/common';
import {
  CHANGE_REQUEST_JSON,
  INHERITED_TASK_KEY,
  NO_CHANGE_CRITERION,
  NO_RUNBOOK_CRITERION,
  RUNBOOK_JSON,
  isAuthoredTaskKey,
  lockedCriterionRefusal,
  plainTextOf,
  validateChangeTicket,
} from '@learnsdlc/shared';
import type {
  ChangeChecks,
  ChangeChecksBody,
  ChangeTicket,
  DraftConfigView,
  DraftTaskView,
  PhaseKey,
  PhaseRubric,
  RubricCriterion,
  RunbookChecks,
  RunbookChecksBody,
} from '@learnsdlc/shared';
import { lockedCriteriaOf, recordCriteriaOf, validateChangeChecks, validateRunbookChecks } from '../content/checks-validation';
import type { ConfigChecks, PhaseChecks } from '../content/content.types';
import type { ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';

/*
 * The authoring service's pure helpers for a task's records and rubric: the
 * builders' views of Deployment's runbook and Maintenance's change request, an
 * inherited task's criteria as its platform version shipped them (any phase),
 * the locked-rubric rule, and each record body held to the loader's own rules.
 * They sit apart from the service so the service keeps to its doors and its
 * database; each reads only its arguments and its imports.
 */

/** A config task's Files-and-checks card: its file rules with their targets, its smoke run and its drill. */
export function configViewOf(checks: ConfigChecks): DraftConfigView {
  return {
    fileRules: checks.rules.map((rule) => ({ id: rule.id, label: rule.label, criterion: rule.criterion, target: rule.target })),
    smoke: { dockerfile: checks.smokeDockerfile, commands: checks.smokeCommands.map((one) => [...one]), expectInOutput: checks.expectInOutput },
    ...(checks.drill
      ? { drill: { fault: checks.drill.fault, description: checks.drill.description, faultedFiles: Object.keys(checks.drill.faultedFiles) } }
      : {}),
  };
}

/**
 * Deployment's and Maintenance's record views, for their builders: the
 * runbook with its floor and drill switch beside the upload-only half the
 * Files-and-checks card shows and the rubric locks (the file rules with their
 * targets, the smoke run, the drill without its faulted bytes), and the
 * ticket with the change request's switch and floor. A task without a record
 * carries none of them.
 */
export function attachRecordViews(held: ProjectTaskEntity[], tasks: DraftTaskView[]): void {
  held.forEach((row, at) => {
    const checks = row.checks;
    if (checks.kind === 'config' && checks.runbook) {
      tasks[at].runbook = { ...checks.runbook, floor: { ...checks.runbook.floor }, drill: !!checks.drill };
      tasks[at].config = configViewOf(checks);
    }
    if (checks.kind === 'code' && checks.change && checks.ticket) {
      tasks[at].change = {
        ticket: { ...checks.ticket, acceptance: checks.ticket.acceptance.map((one) => ({ ...one })) },
        contract: checks.change.contract,
        floor: { ...checks.change.floor },
      };
    }
  });
}

/**
 * An inherited task's criteria as `platform` (the platform version a copy
 * began from) shipped them, or null. A platform version holds no task rows:
 * its tasks are its compiled pack's, keyed the way the copy wrote them out
 * (createProject).
 */
export function packCriteriaIn(platform: ProjectVersionEntity | null, phaseKey: PhaseKey, taskKey: string): RubricCriterion[] | null {
  if (!platform) return null;
  const tasks = platform.compiled?.phases.find((one) => one.key === phaseKey)?.tasks ?? [];
  const shipped = tasks.find((one) => (isAuthoredTaskKey(one.taskKey) ? one.taskKey : INHERITED_TASK_KEY) === taskKey);
  return shipped?.rubric?.criteria ? [...shipped.rubric.criteria] : null;
}

/**
 * A Deployment's or a Maintenance's rubric, held to the rubric rule: the
 * locked keys (the file rules' criteria and `build_smoke`, or the four fixed
 * code keys) each present, and at least one record criterion beside them.
 * A missing key is named by its title in the rubric saved before this edit
 * (`saved`), where it has one, never by the key alone.
 */
export function refuseLockedRubric(checks: PhaseChecks, rubric: PhaseRubric, saved?: PhaseRubric | null): void {
  const keys = new Set(rubric.criteria.map((c) => c.key));
  const titleOf = (key: string) => saved?.criteria?.find((c) => c.key === key)?.title;
  for (const key of lockedCriteriaOf(checks)) if (!keys.has(key)) throw new BadRequestException(lockedCriterionRefusal(key, titleOf(key)));
  if (!recordCriteriaOf(checks, rubric).length) {
    throw new BadRequestException(checks.kind === 'config' ? NO_RUNBOOK_CRITERION : NO_CHANGE_CRITERION);
  }
}

/** A teacher's runbook floor, held to the loader's own rules; the incident toggle is the body's, never the drill's default. */
export function runbookChecksFromBody(body: RunbookChecksBody, hasDrill: boolean): RunbookChecks {
  try {
    return validateRunbookChecks({ record: RUNBOOK_JSON, floor: body?.floor }, 'deployment', hasDrill);
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
}

/** A teacher's contract switch and change floor, held to the loader's own rules. */
export function changeChecksFromBody(body: ChangeChecksBody): ChangeChecks {
  try {
    return validateChangeChecks({ record: CHANGE_REQUEST_JSON, contract: body?.contract, floor: body?.floor }, 'maintenance');
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
}

/**
 * A teacher's ticket, held to the shared validator the loader and the upload
 * door read, then stored as plain text: its title, its summary and
 * each acceptance line through `plainTextOf`, after the check, so a refusal
 * names what the teacher sent; the converted ticket is held to the same check
 * again, so a title or line that converts blank is refused in its sentence.
 */
export function ticketFromBody(body: ChangeTicket): ChangeTicket {
  let ticket: ChangeTicket;
  try {
    ticket = validateChangeTicket(body);
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
  const plain: ChangeTicket = {
    ...ticket,
    title: plainTextOf(ticket.title),
    summary: plainTextOf(ticket.summary),
    acceptance: ticket.acceptance.map((one) => ({ ...one, line: plainTextOf(one.line) })),
  };
  // held to the same check again, so a title or an acceptance line only markdown is refused in its sentence
  try {
    validateChangeTicket(plain);
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
  return plain;
}
