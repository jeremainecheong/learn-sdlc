import * as fs from 'fs';
import * as path from 'path';
import { priceRowOf } from './budget';
import { sha256 } from './io';
import { BEDROCK_MODEL_ID_PATTERN } from './provider/bedrock-settings';

/**
 * The two inputs the harness reads from the evaluation folder, the corpus
 * (`corpus/`) and the model list (`models.json`), validated and refused field
 * by field. An error names the file and the field, never the contents.
 */

const JOB_TYPES = [
  'review-requirements', 'review-design', 'review-implementation', 'review-testing', 'review-deployment', 'review-maintenance',
  'interview-turn', 'mentor-turn', 'agentic-proposal', 'explanation-assessment',
] as const;
export type JobType = typeof JOB_TYPES[number];

/** The five product use-cases the report weighs; the six reviews are one use-case with six phases. */
export type UseCase = 'review' | 'interview' | 'mentor' | 'agentic' | 'explanation';
export const useCaseOf = (jobType: JobType): UseCase =>
  jobType.startsWith('review-') ? 'review'
    : jobType === 'interview-turn' ? 'interview'
      : jobType === 'mentor-turn' ? 'mentor'
        : jobType === 'agentic-proposal' ? 'agentic' : 'explanation';

export interface CorpusCase {
  id: string;
  jobType: JobType;
  schemaVersion: 1;
  source: Record<string, unknown>;
  input: Record<string, any>;
  reference: Record<string, any>;
  tags: { project: string; phase?: string; difficulty?: string; variant?: string; arm?: string; labelTier?: string };
}

function refuse(file: string, field: string, why: string): never {
  throw new Error(`corpus refused: ${path.basename(path.dirname(file))}/${path.basename(file)} field ${field}: ${why}`);
}

function validateCase(value: unknown, file: string): CorpusCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(file, '(root)', 'not an object');
  const c = value as Record<string, any>;
  if (typeof c.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(c.id)) refuse(file, 'id', 'missing or not a safe identifier');
  if (!JOB_TYPES.includes(c.jobType)) refuse(file, 'jobType', 'unknown job type');
  if (c.schemaVersion !== 1) refuse(file, 'schemaVersion', 'only 1 is understood');
  if (!c.input || typeof c.input !== 'object') refuse(file, 'input', 'missing');
  if (!c.reference || typeof c.reference !== 'object') refuse(file, 'reference', 'missing');
  if (!c.tags || typeof c.tags.project !== 'string') refuse(file, 'tags.project', 'missing');
  if (path.basename(file, '.json') !== c.id) refuse(file, 'id', 'does not match the file name');
  if (path.basename(path.dirname(file)) !== c.jobType) refuse(file, 'jobType', 'does not match the folder');
  const i = c.input;
  if (c.jobType.startsWith('review-')) {
    if (!i.reviewInput || typeof i.reviewInput.workspace !== 'object') refuse(file, 'input.reviewInput.workspace', 'missing');
    if (!['recorded', 'derive'].includes(i.deterministicHalf)) refuse(file, 'input.deterministicHalf', 'must be recorded or derive');
  } else if (c.jobType === 'interview-turn') {
    if (typeof i.question !== 'string' || !i.brief) refuse(file, 'input.question/brief', 'missing');
  } else if (c.jobType === 'mentor-turn') {
    if (!i.mentorContext && !(i.subJob === 'guided.review' && typeof i.candidate === 'string')) refuse(file, 'input.mentorContext', 'missing');
  } else if (c.jobType === 'agentic-proposal') {
    if (!['propose', 'chat'].includes(i.mode)) refuse(file, 'input.mode', 'must be propose or chat');
  } else if (c.jobType === 'explanation-assessment') {
    if (!i.data || typeof i.data.learnerAnswer !== 'string') refuse(file, 'input.data.learnerAnswer', 'missing');
  }
  return c as CorpusCase;
}

export function loadCorpus(root: string): { cases: CorpusCase[]; digest: string } {
  const corpusDir = path.join(root, 'corpus');
  const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, 'MANIFEST.json'), 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error('corpus refused: MANIFEST.json field schemaVersion: only 1 is understood');
  if (manifest.privacyFlags && Object.keys(manifest.privacyFlags).length) throw new Error('corpus refused: MANIFEST.json field privacyFlags: the builder flagged private data');
  const cases: CorpusCase[] = [];
  const hash = require('crypto').createHash('sha256');
  for (const jobType of JOB_TYPES) {
    const dir = path.join(corpusDir, jobType);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(dir, name);
      const raw = fs.readFileSync(file);
      hash.update(`${jobType}/${name}\0`).update(raw);
      cases.push(validateCase(JSON.parse(raw.toString('utf8')), file));
    }
  }
  for (const jobType of JOB_TYPES) {
    const declared = manifest.jobs?.[jobType]?.cases;
    const found = cases.filter((c) => c.jobType === jobType).length;
    if (typeof declared === 'number' && declared !== found) throw new Error(`corpus refused: MANIFEST.json field jobs.${jobType}.cases: declares ${declared}, found ${found}`);
  }
  if (manifest.total !== cases.length) throw new Error(`corpus refused: MANIFEST.json field total: declares ${manifest.total}, found ${cases.length}`);
  return { cases, digest: hash.digest('hex') };
}

/* --------------------------------- models --------------------------------- */

/** Judges are candidates too: there is no judge-only role, and a judge never scores its own outputs. */
export type ModelRole = 'candidate' | 'reference';
export type JudgeSlot = 'A' | 'B' | 'C';
export const JUDGE_SLOTS: readonly JudgeSlot[] = ['A', 'B', 'C'];

/**
 * How a Bedrock model's reasoning is held. Thinking is off for every Bedrock
 * model, so each is measured on its answer alone:
 * - `none`: the model has no thinking mode; nothing is sent, and every response
 *   must still carry no reasoning;
 * - `off`: a hybrid model; the documented off switch is sent, and every response
 *   must carry no reasoning;
 * - `minimum`: no off switch exists (gpt-oss); the lowest effort is sent and the
 *   model is marked "reasoning: minimum, cannot be disabled" everywhere.
 */
export type ReasoningPolicy = 'none' | 'off' | 'minimum';
export interface ReasoningSwitch {
  policy: ReasoningPolicy;
  /** Exactly what goes in Converse `additionalModelRequestFields`; null = nothing. */
  fields: Record<string, unknown> | null;
  /** Where the switch (or the absence of a thinking mode) is documented. */
  source: string;
  note: string;
}
export const REASONING_MINIMUM_NOTE = 'reasoning: minimum, cannot be disabled';

export interface EvalModel {
  key: string;
  label: string;
  provider: 'bedrock' | 'openai';
  modelId: string;
  role: ModelRole;
  class: 'onprem' | 'cloud';
  /** Set for the three judge-models (A, B, C); a judge never scores its own outputs. */
  judgeSlot?: JudgeSlot;
  /** On-prem hardware tier (1: one 24-48 GB GPU; 2: one 80 GB GPU); null for cloud. */
  tier: 1 | 2 | null;
  licence: string;
  priceIn: number;
  priceOut: number;
  maxOutputTokens: number;
  contextTokens: number | null;
  hardware: string;
  access: string;
  probe: string;
  reasoning: ReasoningSwitch;
  /** = reasoning.fields: only fields that turn reasoning off or to its lowest setting (provider/bedrock-settings.ts). */
  additionalModelRequestFields: Record<string, unknown> | null;
  runnable: boolean;
  notRunReason: string | null;
}

/** The per-call timeout the harness gives the product when EVAL_CALL_TIMEOUT_MS is not set (boot.ts). */
export const DEFAULT_EVAL_CALL_TIMEOUT_MS = 120_000;

/** The reference arm: the hosted model the product calls, through the OpenAI API, and its alias. */
export const REFERENCE_MODEL_ID = 'gpt-5.6-luna';
export const REFERENCE_KEY = 'gpt56-luna';

/**
 * Stable aliases for models.json rows (by model id). Naming only: which rows
 * run, and which judge, is read from models.json `slate` (the source of truth).
 */
export const KNOWN_MODELS: ReadonlyArray<{ key: string; modelId: string }> = [
  { key: 'llama33-70b', modelId: 'meta.llama3-3-70b-instruct-v1:0' },
  { key: 'llama4-scout', modelId: 'meta.llama4-scout-17b-instruct-v1:0' },
  { key: 'llama4-maverick', modelId: 'meta.llama4-maverick-17b-instruct-v1:0' },
  { key: 'mistral-large-3', modelId: 'mistral.mistral-large-3-675b-instruct' },
  { key: 'mixtral-8x7b', modelId: 'mistral.mixtral-8x7b-instruct-v0:1' },
  { key: 'ministral-3-8b', modelId: 'mistral.ministral-3-8b-instruct' },
  { key: 'ministral-3-14b', modelId: 'mistral.ministral-3-14b-instruct' },
  { key: 'qwen3-32b', modelId: 'qwen.qwen3-32b-v1:0' },
  { key: 'qwen3-235b', modelId: 'qwen.qwen3-235b-a22b-2507-v1:0' },
  { key: 'qwen3-vl-235b', modelId: 'qwen.qwen3-vl-235b-a22b' },
  { key: 'qwen3-next-80b', modelId: 'qwen.qwen3-next-80b-a3b' },
  { key: 'qwen3-coder-30b', modelId: 'qwen.qwen3-coder-30b-a3b-v1:0' },
  { key: 'deepseek-r1', modelId: 'us.deepseek.r1-v1:0' },
  { key: 'deepseek-v31', modelId: 'deepseek.v3-v1:0' },
  { key: 'deepseek-v32', modelId: 'deepseek.v3.2' },
  { key: 'gpt-oss-120b', modelId: 'openai.gpt-oss-120b-1:0' },
  { key: 'gpt-oss-20b', modelId: 'openai.gpt-oss-20b-1:0' },
  { key: 'claude-haiku-45', modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0' },
  { key: 'nova-micro', modelId: 'amazon.nova-micro-v1:0' },
  { key: 'nova-lite', modelId: 'amazon.nova-lite-v1:0' },
  { key: 'nova-pro', modelId: 'amazon.nova-pro-v1:0' },
  { key: 'nova-2-lite', modelId: 'amazon.nova-2-lite-v1:0' },
  { key: REFERENCE_KEY, modelId: `${REFERENCE_MODEL_ID} (OpenAI API)` },
];

const CARD = (slug: string) => `https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-${slug}.html`;
const NO_THINKING = (what: string) => `The Bedrock model card lists no reasoning capability and no thinking switch for ${what}: nothing is sent; every response is still checked for reasoning.`;

/**
 * The reasoning switch per slate model, each taken from the model's own
 * documentation (a field name is verified, never guessed). A slate row with no
 * entry here is refused at load. Every `fields` value also passes the
 * provider's allow-list (provider/bedrock-settings.ts assertReasoningOffFields).
 */
export const REASONING_SWITCHES: Readonly<Record<string, ReasoningSwitch>> = {
  'qwen3-32b': {
    policy: 'off', fields: { enable_thinking: false }, source: CARD('qwen-qwen3-32b'),
    note: 'Bedrock card: "hybrid thinking modes", "Reasoning: Supported", no Bedrock field named. Qwen\'s own card (https://huggingface.co/Qwen/Qwen3-32B): thinking is on by default; the hard switch enable_thinking=False makes the model generate no think content. Sent in additionalModelRequestFields, which Converse accepts. Its effect is proven only by the response assertion and the pre-run probe.',
  },
  'nova-2-lite': {
    policy: 'off', fields: { reasoningConfig: { type: 'disabled' } }, source: 'https://docs.aws.amazon.com/nova/latest/nova2-userguide/extended-thinking.html',
    note: 'Nova 2 user guide, "Extended thinking": additionalModelRequestFields.reasoningConfig.type is "enabled" or "disabled" (default "disabled"); when enabled the answer carries reasoningContent blocks. Sent explicitly so the off state does not rest on a default.',
  },
  'gpt-oss-120b': {
    policy: 'minimum', fields: { reasoning_effort: 'low' }, source: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-openai.html',
    note: 'Bedrock "OpenAI models" request body: OpenAI chat-completion fields not mapped to inferenceConfig go in additionalModelRequestFields; reasoning_effort takes low / medium / high and has no off value. Run at low; reasoning: minimum, cannot be disabled.',
  },
  'gpt-oss-20b': {
    policy: 'minimum', fields: { reasoning_effort: 'low' }, source: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-openai.html',
    note: 'As gpt-oss-120b: reasoning_effort low (its lowest); reasoning: minimum, cannot be disabled.',
  },
  'ministral-3-8b': { policy: 'none', fields: null, source: CARD('mistral-ai-ministral-3-8b'), note: NO_THINKING('Ministral 3 8B (instruct)') },
  'ministral-3-14b': { policy: 'none', fields: null, source: CARD('mistral-ai-ministral-14b-3-0'), note: NO_THINKING('Ministral 3 14B (instruct)') },
  'qwen3-coder-30b': { policy: 'none', fields: null, source: CARD('qwen-qwen3-coder-30b-a3b-instruct'), note: NO_THINKING('Qwen3 Coder 30B A3B Instruct (a non-thinking instruct model)') },
  'llama4-scout': { policy: 'none', fields: null, source: CARD('meta-llama-4-scout-17b-instruct'), note: NO_THINKING('Llama 4 Scout 17B Instruct') },
  'nova-micro': { policy: 'none', fields: null, source: CARD('amazon-nova-micro'), note: NO_THINKING('Nova Micro') },
  'nova-lite': { policy: 'none', fields: null, source: CARD('amazon-nova-lite'), note: NO_THINKING('Nova Lite') },
  [REFERENCE_KEY]: { policy: 'none', fields: null, source: 'https://platform.openai.com/docs/models', note: 'The reference arm keeps the product setting (OpenAI reasoning effort none); not a Bedrock model.' },
};

const SLATE_RUN = new Set(['candidate', 'candidate+judge', 'reference']);

/** "4K" → 4096, "5K" → 5000 (Nova documents 5,000), "128K" → 131072. */
function parseTokenLimit(text: unknown): number | null {
  const m = /^\s*([\d.]+)\s*([KM])?/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!m[2]) return n;
  if (m[2].toUpperCase() === 'M') return Math.round(n * 1_000_000);
  return n === 5 ? 5000 : Math.round(n * 1024);
}

export function loadModels(root: string): { models: EvalModel[]; dropped: string[]; digest: string } {
  const file = path.join(root, 'models.json');
  const raw = fs.readFileSync(file, 'utf8');
  const rows = JSON.parse(raw) as Array<Record<string, any>>;
  if (!Array.isArray(rows)) throw new Error('models refused: models.json (root): not an array');
  const models: EvalModel[] = [];
  const slots = new Map<JudgeSlot, string>();
  for (const row of rows) {
    if (!SLATE_RUN.has(String(row.slate))) continue;
    const key = KNOWN_MODELS.find((k) => k.modelId === row.modelId)?.key;
    if (!key) throw new Error(`models refused: models.json slate row ${String(row.family)}: no harness alias for this model id`);
    const reasoning = REASONING_SWITCHES[key];
    if (!reasoning) throw new Error(`models refused: models.json slate row ${key}: no verified reasoning switch (verify it against the model card, never guess)`);
    const isOpenAi = row.slate === 'reference';
    if (isOpenAi !== (key === REFERENCE_KEY)) throw new Error(`models refused: models.json slate row ${key}: only ${REFERENCE_MODEL_ID} is the reference`);
    const price = priceRowOf({ key, priceIn: row.priceIn, priceOut: row.priceOut });
    const invokeId = isOpenAi ? REFERENCE_MODEL_ID : String(row.invokeId ?? '');
    if (!isOpenAi && !BEDROCK_MODEL_ID_PATTERN.test(invokeId)) throw new Error(`models refused: models.json field invokeId for ${key}: not a Bedrock id`);
    const note = String(row.slateNote ?? '');
    let judgeSlot: JudgeSlot | undefined;
    if (row.slate === 'candidate+judge') {
      const m = /\bjudge ([ABC])\b/.exec(note);
      if (!m) throw new Error(`models refused: models.json slate row ${key}: candidate+judge names no judge slot (A, B or C) in slateNote`);
      judgeSlot = m[1] as JudgeSlot;
      if (slots.has(judgeSlot)) throw new Error(`models refused: models.json: judge slot ${judgeSlot} named twice (${slots.get(judgeSlot)}, ${key})`);
      slots.set(judgeSlot, key);
    }
    const onPrem = row.onPrem === true;
    const tierMatch = /\btier ([12])\b/.exec(note);
    if (onPrem && !tierMatch) throw new Error(`models refused: models.json slate row ${key}: an on-prem candidate needs its hardware tier (1 or 2) in slateNote`);
    const runnable = row.runnable === true && (isOpenAi || row.probe === 'ok');
    models.push({
      key,
      label: String(row.family),
      provider: isOpenAi ? 'openai' : 'bedrock',
      modelId: invokeId,
      role: isOpenAi ? 'reference' : 'candidate',
      class: onPrem ? 'onprem' : 'cloud',
      ...(judgeSlot ? { judgeSlot } : {}),
      tier: onPrem ? (Number(tierMatch![1]) as 1 | 2) : null,
      licence: String(row.licence ?? ''),
      priceIn: price.priceIn,
      priceOut: price.priceOut,
      maxOutputTokens: parseTokenLimit(row.maxOutput) ?? 4096,
      contextTokens: parseTokenLimit(row.contextWindow),
      hardware: String(row.onPremHardware ?? ''),
      access: String(row.access ?? ''),
      probe: String(row.probe ?? ''),
      reasoning,
      additionalModelRequestFields: reasoning.fields,
      runnable,
      notRunReason: runnable ? null : `models.json: access=${row.access}, probe=${row.probe}`,
    });
  }
  if (!models.some((m) => m.role === 'reference')) throw new Error('models refused: models.json: the slate has no reference row');
  const kept = new Set(models.map((m) => m.label));
  const dropped = rows.filter((r) => !kept.has(String(r.family))).map((r) => String(r.family));
  return { models, dropped, digest: sha256(raw) };
}

/** Marks a model whose reasoning cannot be turned off (gpt-oss) in every table and the report. */
export const displayLabel = (m: Pick<EvalModel, 'label' | 'reasoning'>): string => (m.reasoning.policy === 'minimum' ? `${m.label} [${REASONING_MINIMUM_NOTE}]` : m.label);
