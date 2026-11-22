/** @type {import('next').NextConfig} */

const { DEFAULT_API_URL } = require('./public-env');

// CSP has to name the API origin explicitly: 'self' does not stretch to a
// different port, let alone a different host. It is read from the variable the
// browser bundle itself is built against, so the policy and the code it governs
// can never drift apart.
const API_ORIGIN = new URL(process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL).origin;
// Socket.IO upgrades to a WebSocket, and connect-src matches on scheme, so the
// ws:// form of the same origin has to be listed alongside the http:// one.
const API_WS_ORIGIN = API_ORIGIN.replace(/^http/, 'ws');

// next dev compiles with eval-based source maps and React Refresh; the
// production bundle needs neither, so the relaxation stops at the dev server.
const devOnlyEval = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next boots the App Router from an inline <script> and streams the RSC
  // payload through more of them. Nonces would have to be minted per request,
  // which prerendered pages never see, so inline script is allowed outright
  // rather than shipping a policy that claims otherwise and blocks the app.
  `script-src 'self' 'unsafe-inline'${devOnlyEval}`,
  // next/font emits an inline <style> block before the stylesheet loads.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // Monaco's editor worker is a same-origin chunk, but Monaco falls back to
  // wrapping it in a blob: URL whenever it decides the script is cross-origin.
  "worker-src 'self' blob:",
  `connect-src 'self' ${API_ORIGIN} ${API_WS_ORIGIN}`,
  // The live preview frames the learner's own application, which the API
  // serves from its own origin behind a one-use capability. Without this
  // line Chrome refuses the iframe outright with "Framing
  // 'http://localhost:4100/' violates the following Content Security Policy
  // directive: default-src 'self'": `frame-src` falls back to `default-src`,
  // and the panel draws a working session over a blank frame.
  `frame-src 'self' ${API_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // frame-ancestors above is the real control; this repeats it for browsers
  // that still only honour the legacy header.
  { key: 'X-Frame-Options', value: 'DENY' },
  // The app asks for none of these, so no embedded script can either.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

const nextConfig = {
  reactStrictMode: true,
  // Artwork is already sized and optimised in public/ and rendered directly,
  // so the framework's server image transformer and its unauthenticated route
  // are switched off.
  images: { unoptimized: true },
  // Standalone output traces exactly the files the server needs into
  // .next/standalone, so the production image (apps/web/Dockerfile) ships a
  // few MB instead of the monorepo's whole node_modules. The tracing root is
  // the monorepo root because the hoisted node_modules live there. `next start`
  // refuses to serve that build, so `npm start` runs the traced server instead,
  // after copying in the static chunks and public/ that the trace leaves out
  // (the Dockerfile makes the same copy).
  output: 'standalone',
  outputFileTracingRoot: require('path').join(__dirname, '../../'),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
