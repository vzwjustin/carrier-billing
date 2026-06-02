import { cleanupOrphanAuditsFn } from './cleanup-orphan-audits';
import { dispatchFindingWebhookFn } from './dispatch-finding-webhook';
import { dispatchOutboundWebhookFn } from './dispatch-outbound-webhook';
import { processBillFn } from './process-bill';
import { processContractFn } from './process-contract';
import { replayBillingEventsFn } from './replay-billing-events';
import { sendBillUploadRemindersFn } from './send-bill-upload-reminders';
import { sendMonthlyDigestFn } from './send-monthly-digest';
import { sendPaymentFailedEmailFn } from './send-payment-failed-email';
import { sendReportEmailFn } from './send-report-email';
import { sendSlackAutopsyFn, sendSlackHighFindingFn } from './send-slack-notification';

/**
 * Registry of all Inngest functions served by the app.
 */
export const functions = [
  processBillFn,
  processContractFn,
  sendReportEmailFn,
  sendPaymentFailedEmailFn,
  dispatchOutboundWebhookFn,
  dispatchFindingWebhookFn,
  cleanupOrphanAuditsFn,
  replayBillingEventsFn,
  sendBillUploadRemindersFn,
  sendMonthlyDigestFn,
  sendSlackHighFindingFn,
  sendSlackAutopsyFn,
] as const;

export {
  cleanupOrphanAuditsFn,
  dispatchFindingWebhookFn,
  dispatchOutboundWebhookFn,
  processBillFn,
  processContractFn,
  replayBillingEventsFn,
  sendBillUploadRemindersFn,
  sendMonthlyDigestFn,
  sendPaymentFailedEmailFn,
  sendReportEmailFn,
  sendSlackAutopsyFn,
  sendSlackHighFindingFn,
};
