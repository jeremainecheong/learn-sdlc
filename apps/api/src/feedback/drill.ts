import type { DrillReport } from '@learnsdlc/shared';
import { asText } from './text-caps';

export interface DrillInput {
  /** The fault id declared by the content pack, e.g. `entrypoint-shell`. */
  fault: string;
  /** The prose the pack uses to describe the fault to an instructor. */
  description: string;
  /** The smoke run against the faulted copy failed, as it must. */
  failedBeforeFix: boolean;
  /** The same smoke run against the learner's current files passed. */
  passedAfterFix: boolean;
  /** The learner's incident: the runbook record's root cause and fix, the diagnosis's only source (null when there is none). */
  incident: { rootCause: string; fix: string } | null;
  beforeStderr: string;
  afterStdout: string;
}

/** Dockerfile and workflow directives a diagnosis can name. */
const DIRECTIVES = [
  'ENTRYPOINT',
  'CMD',
  'WORKDIR',
  'COPY',
  'ADD',
  'ENV',
  'EXPOSE',
  'FROM',
  'RUN',
  'VOLUME',
  'USER',
  'HEALTHCHECK',
  'needs',
];

/**
 * Words in a fault id that carry no diagnostic weight on their own: naming the
 * fault means naming the thing that broke, not the verb for how it broke.
 */
const FAULT_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'is',
  'no',
  'not',
  'bad',
  'broken',
  'wrong',
  'fault',
  'faulted',
  'drill',
  'removed',
  'missing',
  'deleted',
  'changed',
  'disabled',
  'invalid',
  'empty',
]);

const MAX_OUTPUT = 4000;

const clampOutput = (value: string): string => {
  const trimmed = asText(value).replace(/\s+$/, '');
  return trimmed.length > MAX_OUTPUT ? `${trimmed.slice(0, MAX_OUTPUT)}…` : trimmed;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tokens that would count as naming the fault. Directive names and
 * SCREAMING_SNAKE identifiers found in the pack's description come first,
 * because those are the words a real diagnosis uses; the fault id's own words
 * are the fallback when the description names no directive.
 */
function faultTokens(fault: string, description: string): string[] {
  const desc = asText(description);
  const named: string[] = [];

  for (const directive of DIRECTIVES) {
    if (new RegExp(`\\b${directive}\\b`, 'i').test(desc)) named.push(directive);
  }
  for (const match of desc.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
    if (match[0].length >= 4 && !named.includes(match[0])) named.push(match[0]);
  }
  if (named.length > 0) return named;

  const idWords = asText(fault)
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 3 && !FAULT_STOPWORDS.has(word.toLowerCase()));
  return [...new Set(idWords)];
}

/**
 * Assemble the deployment drill outcome: the smoke run against the faulted copy,
 * the same run against the learner's fix, and whether their incident's root
 * cause and fix actually name the directive that was broken.
 *
 * Pure: no I/O, no clock, no randomness.
 */
export function buildDrillReport(args: DrillInput): DrillReport {
  const fault = asText(args?.fault).trim();
  const faultDescription = asText(args?.description).trim();
  const incident = args?.incident ? `${asText(args.incident.rootCause)}\n${asText(args.incident.fix)}`.trim() : '';
  const tokens = faultTokens(fault, faultDescription);

  const diagnosisNamesFault =
    incident.length > 0 &&
    tokens.length > 0 &&
    tokens.some((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(incident));

  return {
    fault,
    faultDescription,
    failedBeforeFix: args?.failedBeforeFix === true,
    passedAfterFix: args?.passedAfterFix === true,
    diagnosisNamesFault,
    beforeStderr: clampOutput(asText(args?.beforeStderr)),
    afterStdout: clampOutput(asText(args?.afterStdout)),
  };
}
