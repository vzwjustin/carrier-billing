import type { BillReminderEmailProps } from './bill-reminder';

/** Plain-text fallback for the monthly bill-upload reminder. */
export function renderBillReminderText(props: BillReminderEmailProps): string {
  return [
    "Time for this month's bill audit",
    '',
    "New month, new wireless bill. Upload your latest statement and we'll re-check it for overcharges, expired promos, and plan mismatches — usually in under five minutes.",
    '',
    `Upload this month's bill: ${props.uploadUrl}`,
    '',
    "Don't want these reminders? Manage notifications in your settings.",
    'CarrierAudit',
  ].join('\n');
}
