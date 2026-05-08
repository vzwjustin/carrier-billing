import { processBillFn } from './process-bill';
import { sendReportEmailFn } from './send-report-email';

/**
 * Registry of all Inngest functions served by the app.
 */
export const functions = [
  processBillFn,
  sendReportEmailFn,
] as const;

export { processBillFn, sendReportEmailFn };
