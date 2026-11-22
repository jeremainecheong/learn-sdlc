'use client';

import { useEffect, useLayoutEffect } from 'react';

/**
 * `useLayoutEffect` in the browser, `useEffect` on the server.
 *
 * The shell's pages declare their breadcrumbs and their sidebar in a layout
 * effect, because the shell has to know about them in the same commit that
 * mounts the page: a pass that ran after paint would show one frame of the
 * previous page's chrome. React warns that layout effects do nothing during
 * server rendering, which is true and fine here: the server has no shell to
 * update.
 */
export const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
