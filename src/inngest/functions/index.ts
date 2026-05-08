import { helloFn } from './hello';
import { processBillFn } from './process-bill';

/**
 * Registry of all Inngest functions served by the app.
 */
export const functions = [helloFn, processBillFn] as const;

export { helloFn, processBillFn };
