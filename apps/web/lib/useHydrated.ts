'use client';
import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
/** Forms must wait for their client handlers before accepting submission. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
