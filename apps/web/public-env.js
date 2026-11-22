/**
 * The addresses the web app falls back to when its build names none: the API
 * and the public site on their local development ports.
 *
 * CommonJS, because next.config.js requires it as well as the app's own
 * modules importing it. Each reader keeps its literal
 * `process.env.NEXT_PUBLIC_*` read, the form `next build` inlines into the
 * bundle. apps/web/Dockerfile's build-argument defaults are these two values.
 */
module.exports = {
  DEFAULT_API_URL: 'http://localhost:4000',
  DEFAULT_SITE_URL: 'http://localhost:3000',
};
