import { helloFn } from './hello';
import { processBillFn } from './process-bill';
import { sendReportEmailFn } from './send-report-email';

/**
 * Registry of all Inngest functions served by the app.
 */
export const functions = [
  helloFn,
  processBillFn,
  sendReportEmailFn,
] as const;

export { helloFn, processBillFn, sendReportEmailFn };
