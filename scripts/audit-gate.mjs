#!/usr/bin/env node
/** Fail closed on unavailable audit evidence; no framework advisory exemptions. */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Accept npm's advisory exit (1), but never a partial or unverified report. */
export function assessAudit(audit) {
  const invalid = (message) => ({ code: 2, messages: [`Audit unavailable: ${message}`] });
  if (audit.error || audit.signal || ![0, 1].includes(audit.status)) {
    return invalid('npm did not complete successfully.');
  }
  let report;
  try { report = JSON.parse(audit.stdout); }
  catch { return invalid('npm did not produce valid JSON.'); }
  if (!isRecord(report) || report.error || report.auditReportVersion !== 2 ||
      !isRecord(report.vulnerabilities) || !isRecord(report.metadata?.vulnerabilities)) {
    return invalid('npm did not produce a supported, complete report.');
  }
  const entries = Object.entries(report.vulnerabilities);
  const counts = report.metadata.vulnerabilities;
  const actual = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [name, entry] of entries) {
    if (!isRecord(entry) || entry.name !== name || !SEVERITIES.includes(entry.severity) ||
        !Array.isArray(entry.via)) {
      return invalid('the report contains an invalid vulnerability entry.');
    }
    actual[entry.severity]++;
  }
  if (![...SEVERITIES, 'total'].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
      counts.total !== entries.length || SEVERITIES.some((key) => counts[key] !== actual[key])) {
    return invalid('the report totals are missing or inconsistent.');
  }
  if (audit.status === 1 && counts.total === 0) {
    return invalid('npm failed despite reporting no vulnerabilities.');
  }
  const messages = [`npm audit: ${counts.total} vulnerable packages (${counts.critical} critical, ` +
    `${counts.high} high, ${counts.moderate} moderate, ${counts.low} low, ${counts.info} info).`];
  const blocking = entries.map(([, entry]) => entry).filter((entry) => ['high', 'critical'].includes(entry.severity));
  for (const entry of blocking) {
    messages.push(`  ${entry.name}: ${entry.severity}`);
    for (const via of entry.via) {
      if (isRecord(via) && typeof via.url === 'string') messages.push(`    ${via.url}`);
    }
  }
  messages.push(blocking.length
    ? 'High and critical advisories block this check, including framework major upgrades.'
    : 'No high or critical advisories. No exemptions.');
  return { code: blocking.length ? 1 : 0, messages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = assessAudit(spawnSync('npm', ['audit', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  }));
  for (const message of result.messages) console[result.code === 2 ? 'error' : 'log'](message);
  process.exitCode = result.code;
}
