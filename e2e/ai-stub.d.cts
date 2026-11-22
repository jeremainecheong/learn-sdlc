import type { Server } from 'node:http';

/** Types for the canned AI the browser suite grades against (ai-stub.cjs). */
export declare const KEY: string;
export declare const MARKER: string;
export declare const DEFAULT_PORT: number;
export declare function start(port?: number, host?: string): Promise<Server>;
/** Requests answered so far, per call kind. */
export declare const counts: Record<string, number>;
