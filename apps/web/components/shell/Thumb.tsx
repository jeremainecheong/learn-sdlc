'use client';

/**
 * Artefact thumbnails: 24 schematic drawings, one per artefact kind.
 *
 * Every colour is a token, so the same drawing reads in both themes; the only
 * per-instance colour is `hue`, which takes the phase the artefact belongs to.
 *
 * The drawings are schematics, not icons: they show the *shape* of the file
 * (a table has columns, a diff has added and removed lines, a kill matrix has
 * a grid with two live columns) so a learner recognises the artefact before
 * reading its name.
 */
import type { PhaseKey } from '@learnsdlc/shared';
import { phaseHue } from '@/lib/phase';

const MONO = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace";

interface Palette {
  ink: string;
  ink2: string;
  muted: string;
  edge: string;
  surface: string;
  ground: string;
  accent: string;
  pass: string;
  fail: string;
  warn: string;
  hue: string;
}

const n2 = (v: number) => Math.round(v * 100) / 100;
const bar = (x: number, y: number, w: number, h: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;
const box = (x: number, y: number, w: number, h: number, stroke: string, fill = 'none', rx = 3, sw = 1.5, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${extra ? ' ' + extra : ''}/>`;
const ln = (d: string, stroke: string, sw = 1.5, extra = '') =>
  `<path d="${d}" stroke="${stroke}" stroke-width="${sw}"${extra ? ' ' + extra : ''}/>`;
const dot = (cx: number, cy: number, r: number, fill: string, stroke = 'none', sw = 1.5) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const txt = (x: number, y: number, s: string, fill: string, size = 7, anchor = 'middle', weight = 600) =>
  `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${s}</text>`;
const arrow = (x1: number, y1: number, x2: number, y2: number, stroke: string, sw = 1.5, extra = '') => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const L = 4;
  const s = Math.PI / 6;
  const h = (k: number) => `${n2(x2 - L * Math.cos(a + k * s))} ${n2(y2 - L * Math.sin(a + k * s))}`;
  return ln(`M${x1} ${y1}L${x2} ${y2}`, stroke, sw, extra) + ln(`M${h(-1)}L${x2} ${y2}L${h(1)}`, stroke, sw);
};
const folder = (x: number, y: number, w: number, h: number, stroke: string) =>
  ln(`M${x} ${y + 2}a2 2 0 0 1 2-2h3l2 2h${w - 9}a2 2 0 0 1 2 2v${h - 6}a2 2 0 0 1-2 2h-${w - 4}a2 2 0 0 1-2-2z`, stroke);
const file = (x: number, y: number, w: number, h: number, stroke: string) =>
  ln(`M${x} ${y}h${w - 4}l4 4v${h - 4}H${x}z`, stroke) + ln(`M${x + w - 4} ${y}v4h4`, stroke);
const DASH = 'stroke-dasharray="3 3"';

/** Text drawn inside the SVG markup, so a label is escaped before it is written into it. */
const xml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The release tag's version: the one given, or the drawing's own "1.1" where
 * none is. It is set smaller as it grows so it stays inside the tag (about 44
 * units of the 120-unit drawing), and left out when even that would be too
 * small to read, or when the version given is empty.
 */
function releaseTag(c: Palette, label: string | undefined): string {
  const text = (label ?? '1.1').trim();
  if (!text) return '';
  const size = Math.min(12, 44 / (0.6 * text.length));
  return size < 5 ? '' : txt(40, n2(38 + size * 0.375), xml(text), c.ink, n2(size), 'start');
}

const THUMB: Record<string, (c: Palette, label?: string) => string> = {
  issue: (c) =>
    box(14, 10, 92, 56, c.muted) + bar(22, 18, 44, 4, c.ink2) + bar(22, 29, 72, 3, c.muted) + bar(22, 36, 60, 3, c.muted) + bar(22, 43, 66, 3, c.muted) +
    `<rect x="22" y="52" width="20" height="8" rx="4" fill="${c.hue}"/>` + box(46, 52, 20, 8, c.muted, 'none', 4),
  criteria: (c) =>
    [12, 25, 38, 51]
      .map((y) => {
        const sq = (x: number, fill: string) => `<rect x="${x}" y="${y}" width="6" height="6" rx="1.5" fill="${fill}"/>`;
        return sq(10, c.hue) + bar(20, y + 1.5, 16, 3, c.muted) + sq(44, c.ink2) + bar(54, y + 1.5, 18, 3, c.muted) + sq(80, c.muted) + bar(90, y + 1.5, 20, 3, c.muted);
      })
      .join(''),
  contracts: (c) =>
    box(34, 8, 70, 44, c.muted, c.surface) + box(26, 14, 70, 44, c.muted, c.surface) + box(18, 20, 70, 44, c.ink2, c.surface) +
    bar(26, 28, 28, 3.5, c.ink2) + bar(26, 36, 50, 2.5, c.muted) + bar(26, 42, 42, 2.5, c.muted) +
    ln('M28 55c3-6 5-6 8 0s5 6 8 0 5-6 8 0', c.hue) + ln('M26 60h44', c.muted, 1.25),
  model: (c) => {
    const cw = 19.2;
    const x0 = 12;
    let s = `<path d="M15 10h90a3 3 0 0 1 3 3v11H12V13a3 3 0 0 1 3-3z" fill="${c.edge}"/>` + box(12, 10, 96, 56, c.muted);
    for (let i = 1; i < 5; i++) s += ln(`M${n2(x0 + cw * i)} 10v56`, c.muted, 1);
    for (const y of [24, 38, 52]) s += ln(`M12 ${y}h96`, c.muted, 1);
    const ws = [
      [11, 8, 10, 7, 9],
      [9, 11, 7, 10, 8],
      [10, 7, 11, 8, 10],
    ];
    for (let i = 0; i < 5; i++) {
      const x = n2(x0 + cw * i + 4);
      s += bar(x, 15.5, 11, 3.5, c.ink2);
      for (let r = 0; r < 3; r++) s += bar(x, 30 + r * 14, ws[r][i], 2.5, i === 0 && r === 0 ? c.hue : c.muted);
    }
    return s;
  },
  decision: (c) =>
    box(43, 8, 34, 60, c.hue, 'none', 4) +
    [12, 47, 82]
      .map((x, k) => bar(x, 14, 22, 4, c.ink2) + [22, 16, 20, 12].map((w, i) => bar(x, 25 + i * 9, k === 1 ? [26, 18, 22, 14][i] : w, 3, c.muted)).join(''))
      .join(''),
  'class-diagram': (c) =>
    box(10, 10, 44, 52, c.ink2) + ln('M10 24h44', c.ink2) + bar(19, 15, 26, 4, c.ink2) +
    bar(16, 31, 28, 2.5, c.muted) + bar(16, 38, 22, 2.5, c.muted) + bar(16, 45, 30, 2.5, c.muted) + ln('M10 52h44', c.muted, 1.25) + bar(16, 55.5, 20, 2.5, c.muted) +
    box(66, 18, 44, 40, c.ink2) + ln('M66 32h44', c.ink2) + bar(75, 23, 26, 4, c.ink2) + bar(72, 39, 28, 2.5, c.muted) + bar(72, 46, 22, 2.5, c.muted) +
    ln('M54 36h6', c.hue) + ln('M60 32l6 4-6 4z', c.hue),
  components: (c) =>
    [8, 36, 64, 92]
      .map((x, i) => box(x, 28, 20, 18, i === 2 ? c.hue : c.ink2) + bar(x + 4, 34, 12, 3, c.muted) + bar(x + 4, 40, 8, 2.5, c.muted) + (i < 3 ? arrow(x + 21, 37, x + 35, 37, c.muted) : ''))
      .join(''),
  'call-graph': (c) => {
    const N: [number, number][] = [
      [20, 16],
      [52, 12],
      [88, 18],
      [30, 44],
      [64, 42],
      [96, 50],
    ];
    const Ed: [number, number][] = [
      [0, 1],
      [1, 2],
      [0, 3],
      [1, 4],
      [2, 5],
      [3, 4],
    ];
    let s = Ed.map(([a, b]) => ln(`M${N[a][0]} ${N[a][1]}L${N[b][0]} ${N[b][1]}`, c.muted, 1.25)).join('');
    s += N.map(([x, y], i) => dot(x, y, 4.5, i === 0 ? c.hue : c.surface, i === 0 ? c.hue : c.ink2)).join('');
    const bars: [number, number, string][] = [
      [0, 12, c.pass],
      [3, 16, c.pass],
      [4, 5, c.fail],
    ];
    for (const [i, w, col] of bars) {
      const [x, y] = N[i];
      s += bar(x - 8, y + 8.5, 16, 3, c.edge) + bar(x - 8, y + 8.5, w, 3, col);
    }
    return s;
  },
  sequence: (c) =>
    [23, 60, 97].map((x) => box(x - 13, 8, 26, 12, c.ink2, 'none', 2) + bar(x - 7, 12.5, 14, 3, c.ink2) + ln(`M${x} 20v48`, c.muted, 1.25, DASH)).join('') +
    `<rect x="57" y="28" width="6" height="22" fill="${c.edge}" stroke="${c.muted}" stroke-width="1"/>` +
    arrow(23, 32, 55, 32, c.ink2) + arrow(63, 44, 95, 44, c.ink2) + arrow(58, 58, 25, 58, c.hue, 1.5, DASH),
  ledger: (c) =>
    [9, 20.5, 32, 43.5, 55]
      .map((y, i) =>
        bar(12, y + 3.5, [44, 36, 48, 30, 40][i], 3, c.ink2) + bar(64, y + 3.5, 20, 3, c.muted) +
        (i === 2
          ? `<rect x="98" y="${y}" width="10" height="10" rx="2.5" fill="${c.fail}"/>` + ln(`M100.75 ${y + 2.75}l4.5 4.5M105.25 ${y + 2.75}l-4.5 4.5`, c.ink)
          : `<rect x="98" y="${y}" width="10" height="10" rx="2.5" fill="${c.pass}"/>` + ln(`M100.5 ${y + 5.25}l2.25 2.25 4.25-4.5`, c.surface)),
      )
      .join(''),
  'test-report': (c) =>
    [9, 20.5, 32, 43.5, 55].map((y, i) => bar(12, y + 2.5, 14, 3, c.muted) + bar(32, y, 76, 8, c.edge) + bar(32, y, [70, 54, 38, 60, 28][i], 8, i === 2 ? c.fail : c.pass)).join(''),
  'kill-matrix': (c) => {
    const K = [
      [1, 0, 1, 1, 0, 1],
      [1, 0, 0, 1, 0, 1],
      [0, 0, 1, 1, 0, 0],
      [1, 0, 1, 0, 0, 1],
      [1, 0, 1, 1, 0, 1],
      [0, 0, 1, 0, 0, 1],
    ];
    const FAIL = [1, 4];
    let s = '';
    for (let r = 0; r < 6; r++) {
      s += bar(12, 8 + r * 10 + 2.5, 14, 3, c.muted);
      for (let k = 0; k < 6; k++) {
        const x = 31 + k * 10;
        const y = 8 + r * 10;
        s += FAIL.includes(k)
          ? box(x + 0.5, y + 0.5, 7, 7, c.fail, 'none', 1.5, 1.25)
          : `<rect x="${x}" y="${y}" width="8" height="8" rx="1.5" fill="${K[r][k] ? c.pass : c.edge}"/>`;
      }
    }
    return s;
  },
  'coverage-map': (c) => {
    const ON = ['0,1', '2,0', '4,2'];
    let s = '';
    for (let r = 0; r < 4; r++) {
      s += bar(8, 15 + r * 12 + 3.5, 7, 3, c.muted);
      for (let k = 0; k < 6; k++) s += `<rect x="${19 + k * 14}" y="${15 + r * 12}" width="12" height="10" rx="2" fill="${ON.includes(`${r},${k}`) ? c.hue : c.edge}"/>`;
    }
    return s;
  },
  pipeline: (c) =>
    `<path d="M8 26h22l7 12-7 12H8z" fill="${c.pass}"/>` + bar(14, 36.5, 12, 3, c.surface) +
    `<path d="M42 26h22l7 12-7 12H42l7-12z" fill="${c.pass}"/>` + bar(52, 36.5, 12, 3, c.surface) +
    ln('M76 26h22l7 12-7 12H76l7-12z', c.hue) + bar(86, 36.5, 12, 3, c.hue),
  runbook: (c) =>
    box(30, 6, 60, 64, c.ink2) +
    [19, 36, 53].map((y, i) => dot(40, y, 4.5, 'none', c.hue) + txt(40, y + 2.3, String(i + 1), c.hue, 6.5) + bar(48, y - 3, [32, 26, 30][i], 3, c.ink2) + bar(48, y + 2.5, [24, 30, 20][i], 2.5, c.muted)).join(''),
  incident: (c) =>
    ln('M10 50H110', c.muted, 1.25) + [10, 30, 50, 70, 90, 110].map((x) => ln(`M${x} 54v4`, c.muted, 1.25)).join('') +
    ln('M36 50l6-30 5 26 4-12 3 16', c.fail) + dot(24, 50, 3.5, c.hue) + dot(54, 50, 3.5, c.warn) + dot(90, 50, 3.5, c.pass),
  diff: (c) =>
    ([
      [0, 44, 'n'],
      [8, 58, 'n'],
      [8, 46, 'r'],
      [8, 52, 'r'],
      [8, 50, 'g'],
      [8, 64, 'g'],
      [16, 40, 'g'],
      [0, 28, 'n'],
    ] as [number, number, string][])
      .map(([ind, w, k], i) => {
        const y = 8 + i * 7.5;
        const col = k === 'r' ? c.fail : k === 'g' ? c.pass : c.muted;
        return (k !== 'n' ? `<rect x="10" y="${y - 1}" width="3" height="6" rx="1" fill="${col}"/>` : '') + bar(20 + ind, y, w, 4, col);
      })
      .join(''),
  'graph-diff': (c) => {
    const L: [number, number][] = [
      [20, 20],
      [42, 22],
      [30, 44],
      [18, 58],
    ];
    const Ed: [number, number][] = [
      [0, 1],
      [0, 2],
      [2, 3],
      [1, 2],
    ];
    const g = (N: [number, number][], col: string) =>
      Ed.map(([a, b]) => ln(`M${N[a][0]} ${N[a][1]}L${N[b][0]} ${N[b][1]}`, col, 1.25)).join('') + N.map(([x, y]) => dot(x, y, 4, c.surface, col)).join('');
    const Rn: [number, number][] = L.map(([x, y]) => [x + 64, y]);
    return (
      g(L, c.muted) + ln('M60 10v56', c.edge, 1.5, DASH) + ln('M94 44L106 52', c.hue, 1.25) + g(Rn, c.ink2) + dot(106, 52, 4, c.hue) +
      dot(105, 11, 5, c.pass) + ln('M102.5 11h5M105 8.5v5', c.surface, 1.5)
    );
  },
  changelog: (c) =>
    [9, 23, 37, 51]
      .map(
        (y, i) =>
          (i === 0
            ? `<rect x="12" y="${y}" width="24" height="10" rx="2.5" fill="${c.hue}"/>` + txt(24, y + 7.3, '1.1', c.surface, 6.5)
            : box(12, y, 24, 10, c.muted, 'none', 2.5) + txt(24, y + 7.3, ['', '1.0', '0.9', '0.8'][i], c.muted, 6.5)) +
          bar(44, y + 1.5, [50, 40, 56, 36][i], 3, c.ink2) + bar(44, y + 6.5, [30, 26, 34, 22][i], 2.5, c.muted),
      )
      .join(''),
  release: (c, label) => ln('M22 16h42l26 22-26 22H22a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4z', c.ink2) + dot(28, 38, 3, c.hue) + releaseTag(c, label),
  repo: (c) =>
    folder(14, 9, 14, 11, c.ink2) + bar(34, 12.75, 36, 3.5, c.ink2) + ln('M21 20v40', c.muted, 1.25) +
    [27, 41, 55]
      .map((y, i) => ln(`M21 ${y + 5}h6`, c.muted, 1.25) + (i === 2 ? file(31, y, 10, 10, c.muted) : folder(30, y, 12, 10, i === 1 ? c.hue : c.muted)) + bar(48, y + 3.5, [30, 40, 24][i], 3, i === 1 ? c.ink2 : c.muted))
      .join(''),
  pr: (c) =>
    ln('M30 10v56', c.ink2) + ln('M30 18c0 10 38 6 38 16v10c0 10-38 6-38 16', c.hue) + dot(30, 18, 4, c.surface, c.ink2) + dot(68, 36, 3.5, c.hue) + dot(68, 42, 3.5, c.hue) +
    dot(30, 60, 4.5, c.pass) + box(84, 12, 24, 14, c.muted, 'none', 3) + txt(96, 21.5, 'PR', c.ink2, 7),
  'story-map': (c) =>
    box(38, 8, 44, 22, c.hue) + bar(45, 14, 24, 3.5, c.ink2) + bar(45, 21, 30, 2.5, c.muted) +
    ln('M60 30v5M24 35h72M24 35v7M60 35v7M96 35v7', c.muted, 1.25) +
    [8, 44, 80].map((x) => box(x, 42, 32, 26, c.ink2) + bar(x + 6, 49, 18, 3, c.ink2) + bar(x + 6, 56, 20, 2.5, c.muted) + bar(x + 6, 61, 14, 2.5, c.muted)).join(''),
  timeline: (c) =>
    bar(10, 14, 30, 3.5, c.ink2) + ln('M10 34H110', c.muted) +
    [14, 37, 60, 83, 106].map((x, i) => (i < 3 ? dot(x, 34, 4.5, c.pass) : i === 3 ? dot(x, 34, 4.5, c.hue) : dot(x, 34, 4.5, c.surface, c.muted)) + bar(x - 8, 44, 16, 3, c.muted)).join(''),
};

/** Every drawing this component can make, in the order the design sheet lists them. */
const THUMB_KINDS = [
  'issue',
  'criteria',
  'contracts',
  'model',
  'decision',
  'class-diagram',
  'components',
  'call-graph',
  'sequence',
  'ledger',
  'test-report',
  'kill-matrix',
  'coverage-map',
  'pipeline',
  'runbook',
  'incident',
  'diff',
  'graph-diff',
  'changelog',
  'release',
  'repo',
  'pr',
  'story-map',
  'timeline',
] as const;

export type ThumbKind = (typeof THUMB_KINDS)[number];

const TOKENS: Palette = {
  ink: 'rgb(var(--c-ink))',
  ink2: 'rgb(var(--c-ink2))',
  muted: 'rgb(var(--c-muted))',
  edge: 'rgb(var(--c-edge2))',
  surface: 'rgb(var(--c-surface))',
  ground: 'rgb(var(--c-ground))',
  accent: 'rgb(var(--c-accent))',
  pass: 'rgb(var(--c-pass))',
  fail: 'rgb(var(--c-fail))',
  warn: 'rgb(var(--c-warn))',
  hue: 'rgb(var(--c-accent))',
};

/**
 * Names an artefact maps to a drawing by. The match is on substrings so a
 * title the API invented ("PR-3: manager.py", "Kill matrix, six bugs") still
 * lands on the right schematic instead of the fallback.
 */
const MATCH: [string, ThumbKind][] = [
  ['story', 'issue'],
  ['criteria coverage', 'coverage-map'],
  ['criteria to test', 'coverage-map'],
  ['coverage', 'coverage-map'],
  ['criteria', 'criteria'],
  ['backlog', 'story-map'],
  ['model', 'model'],
  ['contract', 'contracts'],
  ['decision', 'decision'],
  ['class', 'class-diagram'],
  ['component', 'components'],
  ['call graph', 'call-graph'],
  ['sequence', 'sequence'],
  ['ledger', 'ledger'],
  ['test report', 'test-report'],
  ['regression', 'test-report'],
  ['kill', 'kill-matrix'],
  ['mutant', 'diff'],
  ['pipeline', 'pipeline'],
  ['runbook', 'runbook'],
  ['incident', 'incident'],
  ['change impact', 'graph-diff'],
  ['release', 'release'],
  ['changelog', 'changelog'],
  ['pr-', 'pr'],
  ['repo', 'repo'],
  ['dockerfile', 'pipeline'],
  ['manager.py', 'diff'],
  ['_task', 'diff'],
  ['test_', 'test-report'],
  ['timeline', 'timeline'],
];

/** The drawing an artefact called `name` should carry. Falls back to `issue`. */
export function thumbKind(name: string): ThumbKind {
  const n = name.toLowerCase();
  const hit = MATCH.find(([k]) => n.includes(k));
  return hit ? hit[1] : 'issue';
}

/**
 * One artefact thumbnail. `size` scales the 120x76 drawing; the aspect is
 * fixed, so pass a width and the height follows.
 */
export function Thumb({
  kind,
  size = 84,
  hue,
  className = '',
  title,
  label,
}: {
  kind: ThumbKind | string;
  /** Drawn width in px. Height is size * 76/120. */
  size?: number;
  /** Phase whose hue the one accented element takes. Defaults to the accent. */
  hue?: PhaseKey;
  className?: string;
  /** Spoken name. Without one the drawing is decorative and hidden. */
  title?: string;
  /**
   * The release drawing's version, where the drawing stands for one release
   * record (the change request's card): that record's version, or '' for none,
   * so the tag never names another. Ignored by every other drawing.
   */
  label?: string;
}) {
  const draw = THUMB[kind] ?? THUMB.issue;
  const palette: Palette = hue ? { ...TOKENS, hue: phaseHue(hue) } : TOKENS;
  const body =
    `<rect x=".75" y=".75" width="118.5" height="74.5" rx="6" fill="${palette.surface}" stroke="${palette.edge}" stroke-width="1.5"/>` + draw(palette, label);
  return (
    <svg
      width={size}
      height={Math.round((size * 76) / 120)}
      viewBox="0 0 120 76"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`block shrink-0 ${className}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-thumb={kind}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
