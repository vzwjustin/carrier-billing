import { helloFn } from './hello';

/**
 * Registry of all Inngest functions served by the app. Phase 1 will
 * add `processBillFn` here.
 */
export const functions = [helloFn] as const;

export { helloFn };
