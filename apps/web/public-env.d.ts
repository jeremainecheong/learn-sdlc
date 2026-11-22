/**
 * Types for public-env.js, which stays CommonJS so next.config.js can require
 * it. The browser tests import the web app's API client and are type-checked
 * without allowJs, so they read the shape from here.
 */
export const DEFAULT_API_URL: string;
export const DEFAULT_SITE_URL: string;
