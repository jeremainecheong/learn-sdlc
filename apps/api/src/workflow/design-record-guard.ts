import { BadRequestException } from '@nestjs/common';
import { API_CONTRACT_JSON, SCREEN_CONTRACT_JSON, designDocumentPaths, readDesignDocument, serialiseDesign } from '@learnsdlc/shared';
import type { PhaseChecks } from '../content/content.types';

/**
 * A save to one of a design task's documents: the learner's own, and an
 * Agentic Apply. A contract that is switched off is refused whether or not a
 * pack mounts its path, because it is not part of the design. A document that
 * is not valid is refused with the sentence `designDocumentError` says. The
 * record is otherwise stored as validated (`serialiseDesign`), so a key the
 * record does not have is never stored; a contract is kept as sent, because
 * the contracts keep their own shape. Any other path, or a phase of another
 * kind, is stored as sent.
 */
export function refuseInvalidDesignDocument(path: string, content: string, checks: PhaseChecks): string {
  if (checks.kind !== 'design') return content;
  if ((path === API_CONTRACT_JSON || path === SCREEN_CONTRACT_JSON) && !designDocumentPaths(checks.contracts).includes(path)) {
    throw new BadRequestException(`The ${path === API_CONTRACT_JSON ? 'API' : 'screen'} contract is switched off in this design and cannot be saved.`);
  }
  const read = readDesignDocument(path, content);
  if (read.error) throw new BadRequestException(read.error);
  return path === checks.record ? serialiseDesign(read.design!) : content;
}
