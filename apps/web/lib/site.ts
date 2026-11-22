import { DEFAULT_SITE_URL } from '../public-env';

/**
 * The canonical public origin. Used for canonical URLs, the sitemap, robots
 * and OpenGraph: all of which need an absolute URL, and all of which are
 * wrong (or silently omitted) if it is missing in production.
 *
 * NEXT_PUBLIC_* is inlined by `next build`, not read at boot, so this must be
 * supplied as a Docker build arg (see apps/web/Dockerfile): setting it on the
 * running container changes nothing.
 *
 * Falls back to localhost (public-env.js) so a dev build still renders
 * sensible tags.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL
).replace(/\/$/, '');

export const SITE_NAME = 'LearnSDLC';

export const SITE_DESCRIPTION =
  'Learn the software development life cycle by carrying one real project through every phase of it — with phase mentors, real execution, and feedback you can use to improve your work.';
