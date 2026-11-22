import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  CHANGE_REQUEST_JSON, DESIGN_JSON, RUNBOOK_JSON, serialiseChangeRequest, serialiseDesign, serialiseRunbook,
  validateChangeRequestRecord, validateDesignRecord, validateRunbookRecord, type ChangeRequest, type Design, type Runbook,
} from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import { ALL_ENTITIES, ExecutionRunEntity, PhaseStateEntity } from '../db/entities';
import { recordPack } from '../../test/record-pack';
import { config } from '../config';
import { AgentProposalEntity } from './agent-proposal.entity';
import { AgenticService } from './agentic.service';
import { KeyedLock } from './assistant.service';
import { designBriefing, normaliseDesignProposal } from './design-proposal';
import { normaliseRecordProposal, recordBriefing } from './record-proposal';

/**
 * Briefings that ask for whole documents inside the edit list make the model
 * retype every file it touches: the Design record as pretty JSON escaped
 * inside a JSON string, and in Maintenance a 7.6 KB repository file and an
 * 8.7 KB contract to change a few lines. Under the edit-list contract the
 * briefings ask for a record as one files entry written as compact JSON (the
 * server reads the record and lays it out itself, so the stored proposal is
 * byte for byte the same), and for code and configuration files through
 * edits. The whole-file briefings, which the request-bytes goldens record,
 * carry none of this.
 */
const project = new ContentService().loadProject(recordPack());
const phaseOf = (key: string) => project.phases.find((p) => p.key === key)!;
const design = phaseOf('design');
const deployment = phaseOf('deployment');
const maintenance = phaseOf('maintenance');
const implementation = phaseOf('implementation');
const start = (phase: PhaseContent) => Object.fromEntries(phase.files.filter((f) => f.editable).map((f) => [f.path, f.content]));

// "No line breaks" alone could be read as stripping the line breaks inside a text (a Design sequence is one message
// per line), which the floor would not refuse: the sentence says the breaks it means are
// between the fields, and that a break inside a text stays the JSON escape. A strict-only briefing byte change.
const COMPACT = 'compact JSON on one line, with no indentation and no line breaks between its fields (a line break inside a text stays written as \\n): the server reads the record and lays it out itself.';

describe('the generation briefings under the edit-list contract', () => {
  it('keeps every whole-file briefing byte for byte, the mode\'s default', () => {
    for (const phase of [design, deployment, maintenance, implementation]) {
      expect(designBriefing(phase, 'files')).toBe(designBriefing(phase));
      expect(recordBriefing(phase, 'files')).toBe(recordBriefing(phase));
      expect(`${designBriefing(phase)}${recordBriefing(phase)}`).not.toContain('compact JSON');
    }
    expect(designBriefing(design)).toContain('Return each document you change complete.');
    expect(recordBriefing(deployment)).toContain('the configuration files, each returned whole,');
    expect(recordBriefing(maintenance)).toContain('the code files, each returned whole,');
  });

  it('asks a design phase for each document whole in files, the record as compact JSON and the contracts as laid out', () => {
    const said = designBriefing(design, 'edits');
    expect(said.startsWith(designBriefing(design))).toBe(true);
    expect(said).toContain('Under the edit-list contract each document you change is one files entry holding the whole document, never edits.');
    expect(said).toContain(`Write the contents of the design record \`${DESIGN_JSON}\` as ${COMPACT}`);
    expect(said).toContain('Write each contract laid out as it is saved.');
    const recordOnly = { ...design, checks: { ...(design.checks as object), contracts: { api: false, screens: false } } } as PhaseContent;
    expect(designBriefing(recordOnly, 'edits')).not.toContain('Write each contract');
  });

  it('asks a runbook phase for the configuration files through edits and the record whole as compact JSON', () => {
    const said = recordBriefing(deployment, 'edits');
    expect(said).not.toContain('each returned whole');
    expect(said).toContain('the configuration files, each changed through edits,');
    expect(said).toContain('Change each configuration file through edits; return one whole in files only when it is empty or the request replaces most of it.');
    expect(said).toContain('A request for whole files is met by edits too: the server builds each file whole from the edits, and the learner reviews it whole.');
    expect(said).toContain(`Under the edit-list contract the runbook record \`${RUNBOOK_JSON}\` is one files entry holding the complete record, never edits`);
    expect(said).toContain(`Write the contents of the runbook record \`${RUNBOOK_JSON}\` as ${COMPACT}`);
    // everything the whole-file briefing says of the record stays
    expect(said).toContain('A proposal must never change an item\'s id');
    expect(said).toContain('The incident is written from the drill page: return it exactly as saved.');
  });

  it('asks a change-request phase for the code files through edits and the record whole as compact JSON', () => {
    const said = recordBriefing(maintenance, 'edits');
    expect(said).not.toContain('each returned whole');
    expect(said).toContain('the code files, each changed through edits,');
    expect(said).toContain('Change each code file through edits; return one whole in files only when it is empty or the request replaces most of it.');
    expect(said).toContain(`Under the edit-list contract the change request record \`${CHANGE_REQUEST_JSON}\` is one files entry holding the complete record, never edits`);
    expect(said).toContain(`Write the contents of the change request record \`${CHANGE_REQUEST_JSON}\` as ${COMPACT}`);
    expect(said).toContain('Every covers id is one of the ticket\'s acceptance ids');
  });

  it('adds nothing for a phase without a record or a design', () => {
    expect(designBriefing(implementation, 'edits')).toBe('');
    expect(recordBriefing(implementation, 'edits')).toBe('');
  });
});

describe('a record written as compact JSON is the same proposal', () => {
  const nextDesign: Design = {
    entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [{ name: 'id', type: 'integer', note: 'required' }], responsibilities: ['knows its due date'], satisfies: ['US-4'] }],
    relations: [],
    operations: [{ id: 'O1', name: 'listOverdue', inputs: ['today'], returns: 'Task[]', errors: [], satisfies: ['US-4'], note: 'excludes today' }],
    decisions: [{ id: 'D1', title: 'Clock', choice: 'a parameter', alternative: 'the server clock', rationale: 'replayable', tradeOff: 'callers send it', status: 'proposed', satisfies: ['US-4'] }],
  };
  it('stores the same design record from compact and from laid-out text', () => {
    const live = start(design);
    const laidOut = normaliseDesignProposal({ [DESIGN_JSON]: serialiseDesign(nextDesign) }, design, live, { dropUnchanged: true });
    const compact = normaliseDesignProposal({ [DESIGN_JSON]: JSON.stringify(nextDesign) }, design, live, { dropUnchanged: true });
    expect(compact).toEqual(laidOut);
    expect(compact[DESIGN_JSON]).toBe(serialiseDesign(validateDesignRecord(compact[DESIGN_JSON]).design!));
  });
  it('stores the same runbook and change request from compact and from laid-out text', () => {
    const runbook: Runbook = validateRunbookRecord(start(deployment)[RUNBOOK_JSON]).runbook!;
    const nextRunbook: Runbook = { ...runbook, environment: [...runbook.environment, { id: 'E9', name: 'LOG_LEVEL', purpose: 'How much the API logs.', kind: 'config', example: 'info' }] };
    const live = start(deployment);
    expect(normaliseRecordProposal({ [RUNBOOK_JSON]: JSON.stringify(nextRunbook) }, deployment, live, { dropUnchanged: true }))
      .toEqual(normaliseRecordProposal({ [RUNBOOK_JSON]: serialiseRunbook(nextRunbook) }, deployment, live, { dropUnchanged: true }));
    const change: ChangeRequest = validateChangeRequestRecord(start(maintenance)[CHANGE_REQUEST_JSON], null).change!;
    const nextChange: ChangeRequest = { ...change, tests: [{ id: 'T1', suite: 'tests/test_comments_api.py', covers: ['AC-1'], result: 'pass' }] };
    const liveChange = start(maintenance);
    expect(normaliseRecordProposal({ [CHANGE_REQUEST_JSON]: JSON.stringify(nextChange) }, maintenance, liveChange, { dropUnchanged: true }))
      .toEqual(normaliseRecordProposal({ [CHANGE_REQUEST_JSON]: serialiseChangeRequest(nextChange) }, maintenance, liveChange, { dropUnchanged: true }));
  });
});

/** The propose route against the real pack's Design and Maintenance, the provider mocked, in each edit-list mode. */
describe('the propose route briefs and reads the generation\'s shape', () => {
  let db: DataSource;
  let service: AgenticService;
  let provider: { available: boolean; name: string; structured: jest.Mock };
  let phase: PhaseContent;
  let phaseId: string;
  const held = config.agenticEditList;
  const respond = (value: unknown) => ({ value, tokensIn: 10, tokensOut: 20 });
  const adequate = { adequate: true, feedback: 'A bounded change.', questions: [] };
  const lock = new KeyedLock();

  const on = async (next: PhaseContent) => {
    phase = next;
    db = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [...ALL_ENTITIES.filter(e => e.name !== AgentProposalEntity.name), AgentProposalEntity], synchronize: true });
    await db.initialize();
    phaseId = (await db.getRepository(PhaseStateEntity).save({ userId: 'b7-owner', enrollmentId: 'b7-enrollment', phaseKey: next.key, phaseOrder: 2, status: 'in_progress', workspace: start(next) })).id;
    const workflow = {
      loadOwnedState: async (_userId: string, id: string) => ({ state: await db.getRepository(PhaseStateEntity).findOneByOrFail({ id }), phase }),
      transaction: (fn: any) => db.transaction(fn),
    };
    provider = { available: true, name: 'local-ai:test-double', structured: jest.fn() };
    service = new AgenticService(db.getRepository(AgentProposalEntity), workflow as any, { serialise: (id: string, fn: any) => lock.run(id, fn), recordReviewUsage: jest.fn() } as any, provider as any, db, db.getRepository(ExecutionRunEntity), {} as any);
  };
  afterEach(async () => { config.agenticEditList = held; await db?.destroy(); });

  const nextDesign: Design = {
    entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [{ name: 'id', type: 'integer', note: 'required, assigned by the database' }], responsibilities: ['knows when it is due'], satisfies: ['US-4'] }],
    relations: [],
    operations: [{ id: 'O1', name: 'listOverdue', inputs: ['today'], returns: 'Task[]', errors: [], satisfies: ['US-4'], note: 'excludes today' }],
    decisions: [{ id: 'D1', title: 'Clock', choice: 'a parameter', alternative: 'the server clock', rationale: 'replayable', tradeOff: 'callers send it', status: 'proposed', satisfies: ['US-4'] }],
  };

  it('in strict mode briefs a design phase for compact JSON, and stores what the whole-file mode stores', async () => {
    await on(design);
    config.agenticEditList = 'off';
    provider.structured.mockResolvedValueOnce(respond(adequate)).mockResolvedValueOnce(respond({ files: { [DESIGN_JSON]: serialiseDesign(nextDesign) }, summary: 'Changes design/design.json.' }));
    const whole = await service.propose('b7-owner', phaseId, 'Model the overdue list.');
    expect(provider.structured.mock.calls[1][0]).toContain(designBriefing(design));
    expect(provider.structured.mock.calls[1][0]).not.toContain('compact JSON');

    config.agenticEditList = 'strict';
    provider.structured.mockClear();
    provider.structured.mockResolvedValueOnce(respond(adequate)).mockResolvedValueOnce(respond({ files: [{ path: DESIGN_JSON, contents: JSON.stringify(nextDesign) }], edits: [], summary: 'Changes design/design.json.' }));
    const compact = await service.propose('b7-owner', phaseId, 'Model the overdue list.');
    const [system, , , , schema, call] = provider.structured.mock.calls[1];
    expect(call).toBe('agentic.generate.edits');
    expect(schema).toBeDefined();
    expect(system).toContain(designBriefing(design, 'edits'));
    expect(compact.files).toEqual(whole.files);
    expect(compact.proposalHash).toBe(whole.proposalHash);
    expect(compact.files[DESIGN_JSON]).toBe(serialiseDesign(validateDesignRecord(compact.files[DESIGN_JSON]).design!));
  });

  it('in strict mode briefs a change-request phase for code through edits and the record as compact JSON, and expands both', async () => {
    await on(maintenance);
    config.agenticEditList = 'strict';
    const live = start(maintenance);
    const change: ChangeRequest = validateChangeRequestRecord(live[CHANGE_REQUEST_JSON], null).change!;
    const nextChange: ChangeRequest = { ...change, tests: [{ id: 'T1', suite: 'tests/test_comments_api.py', covers: ['AC-1'], result: 'pass' }] };
    const code = 'api/repository/tasks.py';
    const anchor = live[code].split('\n').find((line) => line.trim().length > 20 && live[code].split(line).length === 2)!;
    provider.structured.mockResolvedValueOnce(respond(adequate)).mockResolvedValueOnce(respond({
      files: [{ path: CHANGE_REQUEST_JSON, contents: JSON.stringify(nextChange) }],
      edits: [{ path: code, oldString: anchor, newString: `${anchor}  # CR-2` }],
      summary: 'Changes api/repository/tasks.py and maintenance/change-request.json.',
    }));
    const proposed = await service.propose('b7-owner', phaseId, 'Record the comments test as passing and mark the task query.');
    const system = provider.structured.mock.calls[1][0] as string;
    expect(system).toContain(recordBriefing(maintenance, 'edits'));
    expect(system).not.toContain('each returned whole');
    expect(proposed.files).toEqual({
      [CHANGE_REQUEST_JSON]: serialiseChangeRequest(validateChangeRequestRecord(serialiseChangeRequest(nextChange), null).change!),
      [code]: live[code].replace(anchor, `${anchor}  # CR-2`),
    });
  });

  it('in mode off sends the whole-file record briefing unchanged', async () => {
    await on(maintenance);
    config.agenticEditList = 'off';
    const live = start(maintenance);
    const change: ChangeRequest = validateChangeRequestRecord(live[CHANGE_REQUEST_JSON], null).change!;
    provider.structured.mockResolvedValueOnce(respond(adequate)).mockResolvedValueOnce(respond({ files: { [CHANGE_REQUEST_JSON]: serialiseChangeRequest({ ...change, tests: [{ id: 'T1', suite: 's', covers: ['AC-1'], result: 'pass' }] }) } }));
    await service.propose('b7-owner', phaseId, 'Record the comments test as passing.');
    const system = provider.structured.mock.calls[1][0] as string;
    expect(system).toContain(recordBriefing(maintenance));
    expect(system).toContain('the code files, each returned whole,');
    expect(system).not.toContain('compact JSON');
  });
});
