// apps/api/src/assistant/record-proposal.spec.ts
import {
  CHANGE_PROPOSAL_REFUSED, CHANGE_REQUEST_JSON, DESIGN_PROPOSAL_UNCHANGED, EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, RUNBOOK_JSON, RUNBOOK_PROPOSAL_REFUSED,
  serialiseChangeRequest, serialiseRunbook, validateChangeRequestRecord, validateRunbookRecord, type Runbook,
} from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { recordPack } from '../../test/record-pack';
import { normaliseRecordProposal, recordBriefing, validateRecordProposal } from './record-proposal';
import { filesThroughEditsSentence, recordCompactSentence } from './proposal-edits';
import { changeSetDocumentOf, explanationReference } from './structured-evidence';

const project = new ContentService().loadProject(recordPack());
const deployment = project.phases.find((p) => p.key === 'deployment')!;
const maintenance = project.phases.find((p) => p.key === 'maintenance')!;
const shelfLike = { ...maintenance, checks: { ...(maintenance.checks as object), change: { ...(maintenance.checks as { change: object }).change, contract: false } } } as typeof maintenance;
const saved: Runbook = { ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'p', kind: 'config' }], incident: { rootCause: 'API_URL', fix: 'f', actionItem: 'a' } };
const live = { [RUNBOOK_JSON]: serialiseRunbook(saved), 'docker-compose.yml': 'services: {}\n' };

describe('normaliseRecordProposal on a runbook', () => {
  it('keeps a valid proposal, carries a renamed id back, and carries the incident in a drill phase', () => {
    const proposed: Runbook = { ...saved, environment: [{ ...saved.environment[0], id: 'E9', purpose: 'Where web sends /api.' }], incident: { rootCause: 'changed', fix: 'x', actionItem: 'y' } };
    const out = normaliseRecordProposal({ [RUNBOOK_JSON]: JSON.stringify(proposed) }, deployment, live, { dropUnchanged: true });
    const runbook = validateRunbookRecord(out[RUNBOOK_JSON]).runbook!;
    expect(runbook.environment[0]).toMatchObject({ id: 'E1', purpose: 'Where web sends /api.' });
    expect(runbook.incident).toEqual(saved.incident);
  });
  it('refuses on the learner\'s own edit a carried field that changed', () => {
    const renamed = { ...saved, environment: [{ ...saved.environment[0], id: 'E9' }] };
    expect(() => normaliseRecordProposal({ [RUNBOOK_JSON]: JSON.stringify(renamed) }, deployment, live, { refuseCarried: true })).toThrow(`${RUNBOOK_PROPOSAL_REFUSED} The edit changes an item's id, or the incident written from the drill, which a proposal keeps as saved.`);
  });
  it('refuses at apply a proposal that changes the incident in a drill phase', () => {
    const touched = serialiseRunbook({ ...saved, incident: { rootCause: 'rewritten', fix: 'f', actionItem: 'a' } });
    expect(() => validateRecordProposal({ [RUNBOOK_JSON]: touched }, deployment, live)).toThrow(RUNBOOK_PROPOSAL_REFUSED);
  });
  it('refuses an invalid record, and a proposal that changes nothing', () => {
    expect(() => normaliseRecordProposal({ [RUNBOOK_JSON]: '{' }, deployment, live)).toThrow(`${RUNBOOK_PROPOSAL_REFUSED} The runbook record is not valid: The runbook record is not valid JSON.`);
    expect(() => normaliseRecordProposal({ [RUNBOOK_JSON]: live[RUNBOOK_JSON] }, deployment, live, { dropUnchanged: true })).toThrow(DESIGN_PROPOSAL_UNCHANGED);
  });
  it('keeps a config file whole and drops an unchanged record beside it', () => {
    const out = normaliseRecordProposal({ [RUNBOOK_JSON]: live[RUNBOOK_JSON], 'docker-compose.yml': 'services:\n  api: {}\n' }, deployment, live, { dropUnchanged: true });
    expect(out).toEqual({ 'docker-compose.yml': 'services:\n  api: {}\n' });
  });
  it('drops a file equal to the saved one beside a changed record, so the proposal is not mixed', () => {
    const changed = serialiseRunbook({ ...saved, environment: [{ ...saved.environment[0], purpose: 'Where web sends /api.' }] });
    const out = normaliseRecordProposal({ [RUNBOOK_JSON]: changed, 'docker-compose.yml': live['docker-compose.yml'] }, deployment, live, { dropUnchanged: true });
    expect(out).toEqual({ [RUNBOOK_JSON]: changed });
    expect(explanationReference(deployment, live, out, { originalRequest: 'r', proposalHash: 'h', latestEdit: null })).toMatchObject({ structured: true, mixed: false });
    expect(() => normaliseRecordProposal({ 'docker-compose.yml': live['docker-compose.yml'] }, deployment, live, { dropUnchanged: true })).toThrow(DESIGN_PROPOSAL_UNCHANGED);
  });
  it('briefs the schema, the floor, the carry rule and the incident rule', () => {
    const said = recordBriefing(deployment);
    expect(said).toContain('deployment/runbook.json');
    expect(said).toContain('at least 2 environment entries');
    expect(said).toContain('never change an item\'s id');
    expect(said).toContain('The incident is written from the drill page');
  });
});

/*
 * Under the edit-list contract ("Prefer edits") "returned complete when you touch it" alone does not say which array,
 * and a model may edit the runbook JSON field by field, quoting `"purpose": ""`, which the starting record holds four
 * times, so the edit list would be refused. In edits mode the record is asked for as one files entry; the whole-file
 * contract's briefing does not carry that sentence.
 */
describe('recordBriefing under the edit-list contract', () => {
  it('asks for the runbook and the change request whole in files, never as edits', () => {
    // Under the edit list the code or configuration files are "each changed through edits", with the edits sentence
    // before this one, and
    // the record's compact-JSON sentence after it; the record is still one files entry, never edits.
    const underEdits = (phase: typeof deployment) => recordBriefing(phase).replace('each returned whole', 'each changed through edits');
    expect(recordBriefing(deployment, 'edits')).toBe(`${underEdits(deployment)}${filesThroughEditsSentence('configuration')} Under the edit-list contract the runbook record \`deployment/runbook.json\` is one files entry holding the complete record, never edits: its empty fields repeat, so the text an edit quotes would not be unique in it.${recordCompactSentence('runbook record', 'deployment/runbook.json')}`);
    expect(recordBriefing(maintenance, 'edits')).toBe(`${underEdits(maintenance)}${filesThroughEditsSentence('code')} Under the edit-list contract the change request record \`${CHANGE_REQUEST_JSON}\` is one files entry holding the complete record, never edits: its empty fields repeat, so the text an edit quotes would not be unique in it.${recordCompactSentence('change request record', CHANGE_REQUEST_JSON)}`);
  });

  it('leaves the whole-file briefing as it was, and a phase without a record briefed with nothing', () => {
    expect(recordBriefing(deployment, 'files')).toBe(recordBriefing(deployment));
    expect(recordBriefing(maintenance, 'files')).toBe(recordBriefing(maintenance));
    expect(recordBriefing(deployment)).not.toMatch(/edit-list/);
    const design = new ContentService().loadProject(recordPack()).phases.find((p) => p.key === 'design')!;
    expect(recordBriefing(design, 'edits')).toBe('');
  });
});

describe('normaliseRecordProposal on a change request', () => {
  const change = { ...EMPTY_CHANGE_REQUEST, tests: [{ id: 'T1', suite: 'suite', covers: ['AC-1'], result: 'not-run' as const }] };
  const liveChange = { [CHANGE_REQUEST_JSON]: serialiseChangeRequest(change) };
  it('refuses a covers id the ticket does not hold', () => {
    const stray = serialiseChangeRequest({ ...change, tests: [{ ...change.tests[0], covers: ['AC-9'] }] });
    expect(() => normaliseRecordProposal({ [CHANGE_REQUEST_JSON]: stray }, maintenance, liveChange)).toThrow(CHANGE_PROPOSAL_REFUSED);
  });
  it('refuses a proposal that changes a switched-off contract', () => {
    const amended = serialiseChangeRequest({ ...change, contract: [{ id: 'C1', method: 'GET', path: '/x', change: 'added', why: 'w' }] });
    expect(() => normaliseRecordProposal({ [CHANGE_REQUEST_JSON]: amended }, shelfLike, liveChange)).toThrow(CHANGE_PROPOSAL_REFUSED);
    expect(validateChangeRequestRecord(normaliseRecordProposal({ [CHANGE_REQUEST_JSON]: amended }, maintenance, liveChange)[CHANGE_REQUEST_JSON], null).change!.contract).toHaveLength(1);
  });
});

describe('the explanation evidence', () => {
  it('names the change-set document per phase, and none for Implementation', () => {
    expect(changeSetDocumentOf(deployment)).toBe('runbook');
    expect(changeSetDocumentOf(maintenance)).toBe('change');
    expect(changeSetDocumentOf(project.phases.find((p) => p.key === 'implementation')!)).toBeNull();
  });
  it('carries the record as changes and the other files as before and proposedFiles', () => {
    const files = { [RUNBOOK_JSON]: serialiseRunbook({ ...saved, environment: [...saved.environment, { id: 'E2', name: 'PORT', purpose: 'p', kind: 'config' }] }), 'docker-compose.yml': 'services:\n  api: {}\n' };
    const out = explanationReference(deployment, live, files, { originalRequest: 'r', proposalHash: 'h', latestEdit: null });
    expect(out).toMatchObject({ structured: true, mixed: true });
    expect(Object.keys(out.reference)).toEqual(['originalRequest', 'changes', 'carried', 'before', 'proposedFiles', 'proposalHash', 'latestEdit']);
    expect(out.reference.proposedFiles).toEqual({ 'docker-compose.yml': 'services:\n  api: {}\n' });
    expect(out.reference.before).toEqual({ 'docker-compose.yml': 'services: {}\n' });
    expect(out.reference.carried).toEqual(['environment entry E1', 'the incident']);
  });
  it('keeps the files-only reference when the proposal touches no record', () => {
    const out = explanationReference(deployment, live, { 'docker-compose.yml': 'x\n' }, { originalRequest: 'r', proposalHash: 'h', latestEdit: null });
    expect(out.structured).toBe(false);
    expect(Object.keys(out.reference)).toEqual(['originalRequest', 'before', 'proposedFiles', 'proposalHash', 'latestEdit']);
  });
});
