import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/** Only the pages a signed-out visitor can actually reach. */
export default function sitemap(): MetadataRoute.Sitemap {
  const routes: { path: string; priority: number; changeFrequency: 'monthly' | 'yearly' }[] = [
    { path: '/', priority: 1, changeFrequency: 'monthly' },
    { path: '/login', priority: 0.4, changeFrequency: 'yearly' },
    { path: '/register', priority: 0.6, changeFrequency: 'yearly' },
    { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  ];
  // A fixed date rather than new Date(): a build-time "now" makes every page
  // look freshly changed on every deploy, which teaches crawlers to ignore it.
  const lastModified = new Date('2026-08-23');
  return routes.map((r) => ({
    url: `${SITE_URL}${r.path}`,
    lastModified,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
