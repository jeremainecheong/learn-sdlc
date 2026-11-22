import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * The listed routes are the signed-in application's main entries: they need a
 * token, so a crawler only ever sees a redirect, and indexing them wastes crawl
 * budget and surfaces dead links in results. Other signed-in routes are not
 * listed and answer a crawler with the same redirect.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard', '/workspace/', '/instructor', '/complete', '/account'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
