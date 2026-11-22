/**
 * The Design room's form helpers over the shared design record. The record,
 * its kinds, its caps and its validation all live in `@learnsdlc/shared`; this
 * module only mints new rows for the forms and names the room's tabs.
 */
import type {
  DesignDecision,
  DesignEntity,
  DesignOperation,
  DesignRelation,
  DesignSwitches,
} from '@learnsdlc/shared';

export {
  DESIGN_JSON,
  ENTITY_KINDS,
  DESIGN_RELATION_KINDS as RELATION_KINDS,
  operationBaseName as baseName,
  type EntityKind,
  type DesignRelationKind as RelationKind,
} from '@learnsdlc/shared';

/** The cardinalities a relation's two ends offer. The blank choice writes no key. */
export const CARDINALITIES = ['', '1', '0..1', '*', '1..*'] as const;

/**
 * The next free id with this prefix: E3 after E1 and E2. Only the ids in the
 * list are taken, so an id freed by removing an item (the last one, say) can
 * be given again.
 */
export function nextId(prefix: string, taken: { id: string }[]): string {
  let n = taken.length + 1;
  const ids = new Set(taken.map((t) => t.id));
  while (ids.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function emptyEntity(taken: DesignEntity[]): DesignEntity {
  return { id: nextId('E', taken), name: '', kind: 'class', attributes: [], responsibilities: [], satisfies: [] };
}

export function emptyRelation(taken: DesignRelation[], from: string, to: string): DesignRelation {
  return { id: nextId('R', taken), from, to, kind: 'association', fromCard: '1', toCard: '*' };
}

export function emptyOperation(taken: DesignOperation[]): DesignOperation {
  return { id: nextId('O', taken), name: '', inputs: [], returns: '', errors: [], satisfies: [] };
}

export function emptyDecision(taken: DesignDecision[]): DesignDecision {
  return {
    id: nextId('D', taken),
    title: '',
    choice: '',
    alternative: '',
    rationale: '',
    tradeOff: '',
    status: 'proposed',
    satisfies: [],
  };
}

export type DesignTab = 'model' | 'api' | 'screens' | 'sequence' | 'decisions' | 'review';

/**
 * The room's tabs, in order. The API contract, the Screens and the Sequence
 * diagram tabs are there only while the teacher has switched them on.
 */
export function designTabs(switches: DesignSwitches): { key: DesignTab; label: string }[] {
  const { contracts, sequence } = switches;
  return [
    { key: 'model', label: 'UML model' },
    ...(contracts.api ? [{ key: 'api' as const, label: 'API contract' }] : []),
    ...(contracts.screens ? [{ key: 'screens' as const, label: 'Screens' }] : []),
    ...(sequence ? [{ key: 'sequence' as const, label: 'Sequence diagram' }] : []),
    { key: 'decisions', label: 'Decisions' },
    { key: 'review', label: 'Review' },
  ];
}
