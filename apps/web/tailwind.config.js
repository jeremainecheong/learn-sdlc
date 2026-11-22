/**
 * Paper (light) and Graphite (dark) share one token layer. Every colour here
 * points at an RGB triplet on :root (see globals.css), so the same class names
 * render both themes and Tailwind's opacity modifiers keep working.
 *
 * @type {import('tailwindcss').Config}
 */
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
const PHASES = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const phase = Object.fromEntries(PHASES.map((k) => [k, `rgb(var(--hue-${k}) / <alpha-value>)`]));
const phasetint = Object.fromEntries(PHASES.map((k) => [k, `rgb(var(--tint-${k}) / <alpha-value>)`]));

module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: c('ground'),
        surface: c('surface'),
        raised: c('raised'),
        edge: c('edge'),
        edge2: c('edge2'),
        ink: c('ink'),
        ink2: c('ink2'),
        muted: c('muted'),
        dim: c('dim'),
        accent: c('accent'),
        onaccent: c('onaccent'),
        tint: c('tint'),
        pass: c('pass'),
        fail: c('fail'),
        warn: c('warn'),
        passtint: c('passtint'),
        failtint: c('failtint'),
        warntint: c('warntint'),
        onstatus: c('onstatus'),
        code: c('code'),
        codeline: c('codeline'),
        gutter: c('gutter'),
        phase,
        phasetint,
      },
      fontFamily: {
        sans: ['Manrope', 'var(--font-geist-sans)', 'Geist', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        none: '0',
        sm: '4px',
        DEFAULT: '6px',
        md: '8px',
        lg: '10px',
        xl: '12px',
        '2xl': '14px',
        '3xl': '16px',
        full: '9999px',
        panel: '22px',
        ctl: '12px',
        chip: '6px',
      },
      borderWidth: {
        1.5: '1.5px',
      },
      boxShadow: {
        none: 'none',
        sm: 'none',
        DEFAULT: 'none',
        md: 'none',
        lg: 'none',
        xl: 'none',
        '2xl': 'none',
        inner: 'none',
        // the one shadow: overlays that genuinely float above the page
        pop: '0 8px 24px rgba(0,0,0,0.12)',
      },
    },
  },
  plugins: [],
};
