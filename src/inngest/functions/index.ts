import { cleanupOrphanAuditsFn } from './cleanup-orphan-audits';
import { dispatchOutboundWebhookFn } from './dispatch-outbound-webhook';
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
  dispatchOutboundWebhookFn,
  cleanupOrphanAuditsFn,
] as const;

export {
  cleanupOrphanAuditsFn,
  dispatchOutboundWebhookFn,
  processBillFn,
  sendPaymentFailedEmailFn,
  sendReportEmailFn,
};
