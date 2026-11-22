import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessAudit } from './audit-gate.mjs';

function report(entries = []) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: entries.length };
  for (const entry of entries) counts[entry.severity]++;
  return { auditReportVersion: 2, vulnerabilities: Object.fromEntries(entries.map((entry) => [entry.name, entry])),
    metadata: { vulnerabilities: counts } };
}
const result = (data, status = Object.keys(data.vulnerabilities ?? {}).length ? 1 : 0) =>
  assessAudit({ status, stdout: JSON.stringify(data) });
const advisory = (name, severity, fixAvailable = true) => ({ name, severity, via: [], fixAvailable });

test('a complete clean report passes', () => assert.equal(result(report()).code, 0));
test('moderate and low findings remain visible below the blocking floor', () => {
  const assessment = result(report([advisory('example', 'moderate'), advisory('other', 'low')]));
  assert.equal(assessment.code, 0);
  assert.match(assessment.messages[0], /2 vulnerable packages.*1 moderate, 1 low/);
});
test('a critical Next major has no framework exemption', () => {
  assert.equal(result(report([advisory('next', 'critical', { name: 'next', version: '17.0.0', isSemVerMajor: true })])).code, 1);
});
test('high findings fail whether patched, unpatched, or a Nest major', () => {
  for (const fix of [true, false, { name: '@nestjs/core', version: '13.0.0', isSemVerMajor: true }]) {
    assert.equal(result(report([advisory('@nestjs/core', 'high', fix)])).code, 1);
  }
});
test('empty, partial, or registry-error reports cannot pass', () => {
  for (const data of [null, {}, [], { error: { code: 'EAI_AGAIN' } }, { vulnerabilities: {} },
    { ...report(), auditReportVersion: 3 }, { ...report(), metadata: {} }]) {
    assert.equal(assessAudit({ status: 0, stdout: JSON.stringify(data) }).code, 2);
  }
});
test('truncated or non-JSON output cannot pass', () => {
  for (const stdout of ['', '{', '<html>error</html>']) assert.equal(assessAudit({ status: 0, stdout }).code, 2);
});
test('process failure or timeout cannot be hidden behind clean JSON', () => {
  for (const extra of [{ status: 2 }, { status: null }, { error: new Error('spawn failed') }, { signal: 'SIGTERM' }]) {
    assert.equal(assessAudit({ status: 0, stdout: JSON.stringify(report()), ...extra }).code, 2);
  }
});
test('missing or contradictory counts cannot conceal a vulnerability', () => {
  const data = report([advisory('next', 'critical')]);
  data.metadata.vulnerabilities.critical = 0;
  assert.equal(result(data).code, 2);
  delete data.metadata.vulnerabilities.high;
  assert.equal(result(data).code, 2);
  const empty = report(); empty.metadata.vulnerabilities.total = 1;
  assert.equal(result(empty).code, 2);
});
test('invalid severity, identity, or evidence shape cannot silently skip an entry', () => {
  for (const replacement of [{ severity: 'unknown' }, { name: 'wrong-name' }, { via: null }]) {
    const data = report([advisory('next', 'critical')]);
    Object.assign(data.vulnerabilities.next, replacement);
    assert.equal(result(data).code, 2);
  }
});
test('an unexplained npm failure cannot pass with zero findings', () => assert.equal(result(report(), 1).code, 2));
test('a zero exit status cannot hide a reported critical vulnerability', () => {
  assert.equal(result(report([advisory('next', 'critical')]), 0).code, 1);
});
