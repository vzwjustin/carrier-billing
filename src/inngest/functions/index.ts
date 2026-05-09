import { cleanupOrphanAuditsFn } from './cleanup-orphan-audits';
import { processBillFn } from './process-bill';
import { sendPaymentFailedEmailFn } from './send-payment-failed-email';
import { sendReportEmailFn } from './send-report-email';

/**
 * Registry of all Inngest functions served by the app.
 */
export const functions = [
  processBillFn,
  sendReportEmailFn,
  sendPaymentFailedEmailFn,
  cleanupOrphanAuditsFn,
] as const;

export {
  cleanupOrphanAuditsFn,
  processBillFn,
  sendPaymentFailedEmailFn,
  sendReportEmailFn,
};
