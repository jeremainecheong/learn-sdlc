import type { EvalModel } from '../contracts';
import { TIE, choose, oneGpuPrecision } from './balanced-report';

const cost: Record<string, number> = { scout: 1.81, q32: 1.56, other: 1.0, slow: 0.5 };
const c = (k: string) => cost[k] ?? null;

describe('balanced pick with the noise-floor tie rule', () => {
  it('keeps the balanced leader when nothing is within the noise floor', () => {
    const r = choose([{ k: 'scout', b: 0.9, q: 0.8, breaches: [] }, { k: 'q32', b: 0.88, q: 0.85, breaches: [] }], c);
    expect(r.pick?.k).toBe('scout');
    expect(r.tied).toBe(false);
    expect(r.tieBroken).toBe(false);
  });
  it('settles a balanced tie (within 0.01) by quality, then cost', () => {
    expect(TIE).toBe(0.01);
    const r = choose([{ k: 'scout', b: 0.8844, q: 0.8183, breaches: [] }, { k: 'q32', b: 0.8822, q: 0.8526, breaches: [] }], c);
    expect(r.pick?.k).toBe('q32');
    expect(r.rival?.k).toBe('scout');
    expect(r.tied && r.tieBroken).toBe(true);
    const sameQ = choose([{ k: 'scout', b: 0.885, q: 0.85, breaches: [] }, { k: 'q32', b: 0.882, q: 0.85, breaches: [] }], c);
    expect(sameQ.pick?.k).toBe('q32');
  });
  it('never picks a model over the 20 s rule while another is within it', () => {
    const r = choose([{ k: 'slow', b: 0.95, q: 0.95, breaches: ['review'] }, { k: 'other', b: 0.7, q: 0.7, breaches: [] }], c);
    expect(r.pick?.k).toBe('other');
    expect(r.flagged).toBe(false);
  });
  it('flags the class when every model breaches', () => {
    const r = choose([{ k: 'slow', b: 0.6, q: 0.9, breaches: ['agentic'] }], c);
    expect(r.pick?.k).toBe('slow');
    expect(r.flagged).toBe(true);
  });
});

describe('precision needed on one GPU', () => {
  const m = (hardware: string, cls: 'onprem' | 'cloud' = 'onprem') => ({ class: cls, hardware }) as EvalModel;
  it('reads the quantisation from the models.json hardware line', () => {
    expect(oneGpuPrecision(m('109B total / 17B active MoE: Meta says 1x H100 80GB with on-the-fly Int4; BF16 ~220 GB: 4x H100'))).toMatch(/^Int4/);
    expect(oneGpuPrecision(m('117B total / 5.1B active MoE, MXFP4: 1x 80 GB GPU'))).toMatch(/^MXFP4/);
    expect(oneGpuPrecision(m('BF16 ~64 GB: 1x H100 80GB; 4-bit ~20 GB: 1x 24 GB GPU'))).toMatch(/^BF16/);
    expect(oneGpuPrecision(m('n/a - cloud only', 'cloud'))).toBe('n/a (cloud)');
  });
});
