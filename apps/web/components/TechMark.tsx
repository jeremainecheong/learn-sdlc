/**
 * File-type and tool marks on the same 24 grid as the outline icons, each in
 * its own single brand colour so they sit beside the icons without shouting.
 */
export type TechName =
  | 'python'
  | 'docker'
  | 'actions'
  | 'yaml'
  | 'json'
  | 'markdown'
  | 'git'
  | 'pytest'
  | 'typescript'
  | 'react'
  | 'javascript'
  | 'toml'
  | 'make'
  | 'text'
  | 'folder'
  | 'linux';

// The generic file types have no brand colour of their own, so they follow the
// theme's muted token instead of a fixed grey that would go dim in Graphite.
const NEUTRAL = 'rgb(var(--c-muted))';

const MARKS: Record<TechName, { color: string; shape: React.ReactNode }> = {
  python: {
    color: '#3776AB',
    shape: (
      <>
        <path
          d="M11.7 3c-3.3 0-3.1 1.4-3.1 1.4v1.5h3.2v.5H7.3S5 6.2 5 9.6s2 3.3 2 3.3h1.2v-1.6s-.1-2 2-2h3.2s1.9 0 1.9-1.9V4.9S15.6 3 11.7 3z"
          fill="currentColor"
          stroke="none"
        />
        <circle cx="10.2" cy="5" r=".7" fill="#fff" stroke="none" />
        <path
          d="M12.3 21c3.3 0 3.1-1.4 3.1-1.4v-1.5h-3.2v-.5h4.5S19 17.8 19 14.4s-2-3.3-2-3.3h-1.2v1.6s.1 2-2 2h-3.2s-1.9 0-1.9 1.9v2.5s-.3 1.9 3.6 1.9z"
          fill="currentColor"
          stroke="none"
          opacity=".72"
        />
        <circle cx="13.8" cy="19" r=".7" fill="#fff" stroke="none" />
      </>
    ),
  },
  docker: {
    color: '#2496ED',
    shape: (
      <>
        <path d="M3 12.5h13.5c1.5 0 2.7-.5 3.4-1.4l.9.4c.4.2 1 .1 1.2-.3-.6-.6-1.6-.8-2.5-.5-.5-1.1-1.4-1.8-2.4-2.1-.6.8-.7 1.9-.3 2.8H3c-.4 3 1.2 6.6 5.9 6.6 4.1 0 7.7-2 9.5-5.6" />
        <path d="M5.5 8.5h2v2h-2zM8 8.5h2v2H8zM10.5 8.5h2v2h-2zM8 6h2v2H8zM10.5 6h2v2h-2zM13 8.5h2v2h-2z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  actions: {
    color: '#2088FF',
    shape: (
      <>
        <circle cx="7" cy="7" r="3.2" />
        <circle cx="17" cy="17" r="3.2" />
        <circle cx="17" cy="7" r="1.6" />
        <path d="M10.2 7h5.2M7 10.2V13a4 4 0 0 0 4 4h2.8" />
        <path d="M6 6.2 6.8 7l1.4-1.6" />
      </>
    ),
  },
  yaml: {
    color: '#CB171E',
    shape: (
      <>
        <path d="M4.5 5.5 8.5 11v6M12.5 5.5 8.5 11" />
        <path d="M15 17V6.5l2.5 4 2.5-4V17" />
      </>
    ),
  },
  json: {
    color: '#C69026',
    shape: (
      <>
        <path d="M9 4.5c-2 0-3 1-3 2.5v2.5c0 1-.7 2-2 2.5 1.3.5 2 1.5 2 2.5V17c0 1.5 1 2.5 3 2.5" />
        <path d="M15 4.5c2 0 3 1 3 2.5v2.5c0 1 .7 2 2 2.5-1.3.5-2 1.5-2 2.5V17c0 1.5-1 2.5-3 2.5" />
      </>
    ),
  },
  markdown: {
    color: NEUTRAL,
    shape: (
      <>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M6.5 15v-6l2.5 3 2.5-3v6M16.5 9v6M14.5 13l2 2 2-2" />
      </>
    ),
  },
  git: {
    color: '#F05032',
    shape: (
      <>
        <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
        <circle cx="12" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="15.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
        <path d="M12 9.9v4.2M13.2 14.4l1.3-1.4" />
      </>
    ),
  },
  pytest: {
    color: '#009FE3',
    shape: (
      <>
        <path d="M4 7h16M5.5 4.5v5M9.8 4.5v5M14.2 4.5v5M18.5 4.5v5" />
        <path d="M5.5 12v7.5M9.8 12v5M14.2 12v6.5M18.5 12v4" />
      </>
    ),
  },
  typescript: {
    color: '#3178C6',
    shape: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="2" fill="currentColor" stroke="none" />
        <path d="M7 10.5h5M9.5 10.5V17" stroke="#fff" strokeWidth="1.7" />
        <path
          d="M17.5 11.2c-.3-.7-1-1-1.8-1-1 0-1.7.6-1.7 1.4 0 1.9 3.8 1.2 3.8 3.5 0 1-.8 1.7-2 1.7-1 0-1.8-.5-2.1-1.3"
          stroke="#fff"
          strokeWidth="1.5"
          fill="none"
        />
      </>
    ),
  },
  // The pack's front end is React, and a `.tsx` is the one file where
  // the difference between "TypeScript" and "a component" is worth a glyph.
  // The brand cyan is lightened past legibility on Paper, so this is the same
  // hue held to the token palette's own floor.
  react: {
    color: '#0E93BC',
    shape: (
      <>
        <circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none" />
        <ellipse cx="12" cy="12" rx="9.5" ry="3.9" />
        <ellipse cx="12" cy="12" rx="9.5" ry="3.9" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9.5" ry="3.9" transform="rotate(120 12 12)" />
      </>
    ),
  },
  javascript: {
    color: '#B7A100',
    shape: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="2" fill="currentColor" stroke="none" />
        <path d="M11 9.5v5.8c0 1-.6 1.6-1.6 1.6-.9 0-1.5-.4-1.8-1.1" stroke="#fff" strokeWidth="1.6" fill="none" />
        <path
          d="M17.6 10.6c-.3-.7-1-1.1-1.8-1.1-1 0-1.7.6-1.7 1.4 0 1.9 3.8 1.2 3.8 3.5 0 1-.8 1.7-2 1.7-1 0-1.8-.5-2.1-1.3"
          stroke="#fff"
          strokeWidth="1.5"
          fill="none"
        />
      </>
    ),
  },
  toml: {
    color: NEUTRAL,
    shape: (
      <>
        <path d="M5 4.5H8v15H5M19 4.5H16v15h3" />
        <path d="M9.5 8h5M12 8v8" />
      </>
    ),
  },
  make: {
    color: NEUTRAL,
    shape: (
      <>
        <rect x="3.5" y="5" width="17" height="14" rx="2" />
        <path d="M7 9.5 10 12l-3 2.5M12 15h5" />
      </>
    ),
  },
  text: {
    color: NEUTRAL,
    shape: (
      <>
        <path d="M6.5 3.5h7L18 8v12.5H6.5z" />
        <path d="M13.5 3.5V8H18" />
        <path d="M9.3 12.6h5.4M9.3 16h3.6" />
      </>
    ),
  },
  folder: {
    color: NEUTRAL,
    shape: (
      <>
        <path
          d="M3.5 7a2 2 0 0 1 2-2h3.3l2 2.4h7.7a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"
          fill="currentColor"
          stroke="none"
          opacity=".35"
        />
        <path d="M3.5 7a2 2 0 0 1 2-2h3.3l2 2.4h7.7a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      </>
    ),
  },
  linux: {
    color: NEUTRAL,
    shape: (
      <>
        <path d="M12 3.5c-2.5 0-3.5 2-3.5 4.5 0 1.5-1 2.5-2 4.5s-1 4 .5 5.5h10c1.5-1.5 1.5-3.5.5-5.5s-2-3-2-4.5c0-2.5-1-4.5-3.5-4.5z" />
        <circle cx="10.5" cy="8" r=".7" fill="currentColor" stroke="none" />
        <circle cx="13.5" cy="8" r=".7" fill="currentColor" stroke="none" />
        <path d="M11 10h2l-1 1.2z" fill="currentColor" stroke="none" />
      </>
    ),
  },
};

/** Which mark a workspace path gets, by name and by what it is for. */
export function techForPath(path: string): TechName {
  const n = path.toLowerCase().split('/').filter(Boolean).pop() ?? path.toLowerCase();
  if (path.endsWith('/') || (!n.includes('.') && !['dockerfile', 'makefile'].includes(n))) return 'folder';
  if (n === 'dockerfile') return 'docker';
  if (n === 'makefile') return 'make';
  if (n.startsWith('test_') || n.endsWith('_test.py') || n === 'conftest.py') return 'pytest';
  if (n.endsWith('.py')) return 'python';
  if (n.endsWith('.yml') || n.endsWith('.yaml')) {
    return path.toLowerCase().includes('.github') || n.includes('ci') || n.includes('workflow') ? 'actions' : 'yaml';
  }
  if (n.endsWith('.json')) return 'json';
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown';
  if (n.endsWith('.toml')) return 'toml';
  // A component and a module are different things to open, and the strip is
  // the one place that difference is worth a glyph.
  if (n.endsWith('.tsx') || n.endsWith('.jsx')) return 'react';
  if (n.endsWith('.ts')) return 'typescript';
  if (n.endsWith('.js') || n.endsWith('.jsx') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'javascript';
  if (n.startsWith('.git')) return 'git';
  if (n.endsWith('.sh') || n.endsWith('.bash')) return 'linux';
  return 'text';
}

export function TechMark({
  name,
  size = 16,
  className = '',
  title,
  mono = false,
}: {
  name: TechName;
  size?: number;
  className?: string;
  title?: string;
  /** Draw in the current text colour instead of the brand colour. */
  mono?: boolean;
}) {
  const m = MARKS[name] ?? MARKS.text;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      style={mono ? undefined : { color: m.color }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {m.shape}
    </svg>
  );
}
