import * as fs from 'fs';
import * as path from 'path';
import { appendLine, readJson, seg, sha256, writeJson } from './io';

/**
 * The resume-safe run log. `ledger.jsonl` is append-only and
 * fsync'd; a unit is `sha256(runId|stage|model|jobType|case)`.
 *
 * - `done` units are skipped on resume.
 * - A unit `started` with no `done` (a crash mid-call) has its worst case
 *   counted as spent and is retried once; a unit that fails twice is `failed`
 *   and is not retried.
 * - `stopped_at_cap`, `failed:credentials` and `failed:transient` (a network
 *   drop, a 5xx, throttling past every backoff) never count as an attempt: the
 *   unit runs again after a resume with budget, a fresh `aws login` or a
 *   working network.
 * - `cut_at_runtime` records a judge unit the live guard skipped to keep the
 *   protected stages funded; it is not an attempt either.
 * - raw records are written (tmp + rename) before the `done` line.
 */

export type LedgerEvent = 'started' | 'done' | 'failed' | 'skipped' | 'stopped_at_cap' | 'failed:credentials' | 'failed:transient' | 'failed:harness' | 'cut_at_runtime';

export interface LedgerLine {
  unit: string;
  stage: string;
  model: string;
  jobType: string;
  case: string;
  event: LedgerEvent;
  costUsd: number;
  worstUsd?: number;
  at: string;
}

export const unitId = (runId: string, stage: string, model: string, jobType: string, caseId: string): string =>
  sha256(`${runId}|${stage}|${model}|${jobType}|${caseId}`).slice(0, 32);

export class Ledger {
  readonly file: string;
  private lines: LedgerLine[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly runDir: string, readonly runId: string) {
    this.file = path.join(runDir, 'ledger.jsonl');
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.lines.push(JSON.parse(line) as LedgerLine); } catch { /* a torn last line from a crash is ignored */ }
      }
    }
  }

  /** One in-process mutex over the shared log. */
  append(line: Omit<LedgerLine, 'at'>): Promise<void> {
    const full: LedgerLine = { ...line, at: new Date().toISOString() };
    this.chain = this.chain.then(() => { appendLine(this.file, JSON.stringify(full)); this.lines.push(full); });
    return this.chain;
  }

  status(unit: string): { done: boolean; failed: boolean; attempts: number } {
    let done = false;
    let failed = false;
    let attempts = 0;
    for (const l of this.lines) {
      if (l.unit !== unit) continue;
      if (l.event === 'done') done = true;
      if (l.event === 'failed') failed = true;
      if (l.event === 'started') attempts += 1;
      if (l.event === 'stopped_at_cap' || l.event === 'failed:credentials' || l.event === 'failed:transient' || l.event === 'failed:harness') attempts -= 1;
    }
    return { done, failed, attempts: Math.max(0, attempts) };
  }

  /** Spend already committed: settled costs plus the worst case of every orphaned start. */
  spent(): number {
    const byUnit = new Map<string, LedgerLine[]>();
    for (const l of this.lines) byUnit.set(l.unit, [...(byUnit.get(l.unit) ?? []), l]);
    let total = 0;
    for (const lines of byUnit.values()) {
      let open: LedgerLine | null = null;
      for (const l of lines) {
        if (l.event === 'started') { if (open) total += open.worstUsd ?? 0; open = l; } else {
          total += l.costUsd || 0;
          open = null;
        }
      }
      if (open) total += open.worstUsd ?? 0;
    }
    return total;
  }

  byStage(): Record<string, { done: number; failed: number; stopped: number; credentials: number; transient: number; cutAtRuntime: number; costUsd: number }> {
    const out: Record<string, { done: number; failed: number; stopped: number; credentials: number; transient: number; cutAtRuntime: number; costUsd: number }> = {};
    for (const l of this.lines) {
      const s = (out[l.stage] ??= { done: 0, failed: 0, stopped: 0, credentials: 0, transient: 0, cutAtRuntime: 0, costUsd: 0 });
      if (l.event === 'failed:transient') s.transient += 1;
      if (l.event === 'cut_at_runtime') s.cutAtRuntime += 1;
      if (l.event === 'done') s.done += 1;
      if (l.event === 'failed') s.failed += 1;
      if (l.event === 'stopped_at_cap') s.stopped += 1;
      if (l.event === 'failed:credentials') s.credentials += 1;
      s.costUsd += l.costUsd || 0;
    }
    return out;
  }

  all(): readonly LedgerLine[] { return this.lines; }

  writeSpend(extra: Record<string, unknown> = {}): void {
    writeJson(path.join(this.runDir, 'spend.json'), { runId: this.runId, spentUsd: Number(this.spent().toFixed(6)), byStage: this.byStage(), ...extra, at: new Date().toISOString() });
  }
}

export const rawPath = (runDir: string, model: string, jobType: string, caseId: string): string =>
  path.join(runDir, 'raw', seg(model), jobType, `${seg(caseId)}.json`);
export const execPath = (runDir: string, model: string, caseId: string): string =>
  path.join(runDir, 'exec', seg(model), `${seg(caseId)}.json`);
export const judgePath = (runDir: string, judge: string, kind: string, model: string, caseId: string): string =>
  path.join(runDir, 'judge', seg(judge), kind, seg(model), `${seg(caseId)}.json`);

export function readIf<T>(file: string): T | null {
  return fs.existsSync(file) ? readJson<T>(file) : null;
}
