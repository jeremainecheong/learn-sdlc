import { BadRequestException } from '@nestjs/common';
import { refuseInvalidDesignDocument } from './design-record-guard';
import { DEFAULT_DESIGN_FLOOR, DESIGN_JSON, EMPTY_DESIGN, serialiseDesign, type DesignChecksSpec } from '@learnsdlc/shared';

const checks: DesignChecksSpec = { kind: 'design' as const, record: DESIGN_JSON, contracts: { api: true, screens: true }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR };
describe('refuseInvalidDesignDocument', () => {
  it('stores the record as validated, so an unknown key is never stored', () => {
    const stored = refuseInvalidDesignDocument(DESIGN_JSON, JSON.stringify({ ...EMPTY_DESIGN, fields: [], padding: 'x'.repeat(100_000) }), checks);
    expect(stored).toBe(serialiseDesign(EMPTY_DESIGN));
  });
  it('drops an unknown key nested in an item too, never storing it', () => {
    const entity = { id: 'E1', name: 'Task', kind: 'class' as const, attributes: [{ name: 'id', type: 'integer' }], responsibilities: [], satisfies: [] };
    const sent = JSON.stringify({ ...EMPTY_DESIGN, entities: [{ ...entity, padding: 'x'.repeat(100_000), attributes: [{ ...entity.attributes[0], extra: 'y' }] }] });
    const stored = refuseInvalidDesignDocument(DESIGN_JSON, sent, checks);
    expect(stored).toBe(serialiseDesign({ ...EMPTY_DESIGN, entities: [entity] }));
    expect(stored).not.toContain('padding');
    expect(stored).not.toContain('extra');
  });
  it('refuses a malformed record with the fixed sentence', () => {
    expect(() => refuseInvalidDesignDocument(DESIGN_JSON, '{', checks)).toThrow(new BadRequestException('The design record is not valid: The design record is not valid JSON.'));
  });
  it('refuses 31 operations', () => {
    const big = JSON.stringify({ ...EMPTY_DESIGN, operations: Array.from({ length: 31 }, (_, i) => ({ id: `O${i + 1}`, name: 'x', inputs: [], returns: '', errors: [], satisfies: [] })) });
    expect(() => refuseInvalidDesignDocument(DESIGN_JSON, big, checks)).toThrow(/more than 30 operations/);
  });
  it('refuses a broken contract and keeps a good one as sent', () => {
    expect(() => refuseInvalidDesignDocument('shared/contract/api.json', '{"errors":{}}', checks)).toThrow('The API contract is not valid: The API contract has no operations list.');
    expect(() => refuseInvalidDesignDocument('shared/contract/screens.json', '[]', checks)).toThrow('The screen contract is not valid: The screen contract is not an object.');
    const api = '{ "$comment": "kept", "operations": [] }';
    expect(refuseInvalidDesignDocument('shared/contract/api.json', api, checks)).toBe(api);
  });
  it('ignores other paths and other kinds', () => {
    expect(refuseInvalidDesignDocument('notes.txt', '{', checks)).toBe('{');
    expect(refuseInvalidDesignDocument(DESIGN_JSON, '{', { kind: 'markdown', targets: [], rules: [] } as never)).toBe('{');
  });
  it('refuses a write to a contract that is switched off, valid or not, whether or not the path is mounted', () => {
    const off = { ...checks, contracts: { api: false, screens: false } };
    expect(() => refuseInvalidDesignDocument('shared/contract/screens.json', '[]', off)).toThrow(new BadRequestException('The screen contract is switched off in this design and cannot be saved.'));
    expect(() => refuseInvalidDesignDocument('shared/contract/api.json', '{"operations":[]}', off)).toThrow(new BadRequestException('The API contract is switched off in this design and cannot be saved.'));
  });
});
