import { BALANCE, balancedOf, eligibleForJob, latencyTerm, weightVariants } from './balanced';

describe('balanced choice', () => {
  it('scores latency 1 at p95 <= 10 s with nothing over 20 s', () => {
    expect(latencyTerm(10_000, 0)).toBe(1);
    expect(latencyTerm(4_000, 0)).toBe(1);
  });
  it('scores latency 0 at p95 >= 30 s or >= 10% over 20 s', () => {
    expect(latencyTerm(30_000, 0)).toBe(0);
    expect(latencyTerm(5_000, 0.1)).toBe(0);
    expect(latencyTerm(37_000, 0.12)).toBe(0);
  });
  it('is linear between and takes the worse of the two terms', () => {
    expect(latencyTerm(20_000, 0)).toBeCloseTo(0.5);
    expect(latencyTerm(10_000, 0.05)).toBeCloseTo(0.5);
    expect(latencyTerm(15_000, 0.08)).toBeCloseTo(0.2);
  });
  it('returns null when latency was not measured', () => {
    expect(latencyTerm(null, 0)).toBeNull();
    expect(balancedOf(0.9, null)).toBeNull();
  });
  it('combines quality 0.6 and latency 0.4 by default', () => {
    expect(BALANCE).toEqual({ quality: 0.6, latency: 0.4 });
    expect(balancedOf(0.85, 1)).toBeCloseTo(0.91);
  });
  it('makes a worked example explicit: Qwen3 Coder 30B (0.87, review p95 37 s, 12% over) loses reviews to Qwen3 32B (0.85, 5.5 s)', () => {
    const coder = balancedOf(0.87, latencyTerm(37_000, 0.12))!;
    const q32 = balancedOf(0.85, latencyTerm(5_500, 0))!;
    expect(q32).toBeGreaterThan(coder);
    expect(eligibleForJob(37_000)).toBe(false);
    expect(eligibleForJob(5_500)).toBe(true);
    expect(eligibleForJob(20_000)).toBe(true);
    expect(eligibleForJob(null)).toBe(false);
  });
  it('varies each weight by ±25% and renormalises to 1', () => {
    const v = weightVariants();
    expect(v.map((x) => x.name)).toEqual(['baseline', 'quality ×0.75', 'quality ×1.25', 'latency ×0.75', 'latency ×1.25']);
    for (const x of v) expect(x.quality + x.latency).toBeCloseTo(1);
    expect(v[1].quality).toBeCloseTo(0.45 / 0.85);
    expect(v[4].latency).toBeCloseTo(0.5 / 1.1);
  });
});
