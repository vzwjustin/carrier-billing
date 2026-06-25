import { cleanupExpiredShareTokensFn } from './cleanup-expired-share-tokens';
import { cleanupOrphanAuditsFn } from './cleanup-orphan-audits';
import { dispatchOutboundWebhookFn } from './dispatch-outbound-webhook';
import { processBillFn } from './process-bill';
import { replayBillingEventsFn } from './replay-billing-events';
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
  cleanupExpiredShareTokensFn,
  replayBillingEventsFn,
] as const;

export {
  cleanupExpiredShareTokensFn,
  cleanupOrphanAuditsFn,
  dispatchOutboundWebhookFn,
  processBillFn,
  replayBillingEventsFn,
  sendPaymentFailedEmailFn,
  sendReportEmailFn,
};
