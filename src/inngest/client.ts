import { EventSchemas, Inngest } from 'inngest';

import { env } from '@/env';

/**
 * Typed event registry for the CarrierAudit Inngest client.
 *
 * Add new events here as they are introduced. The shape is
 * `{ data: <payload> }` per the Inngest typed-events API.
 */
export type Events = {
  'bill.uploaded': {
    data: {
      auditId: string;
      userId: string;
      storagePath: string;
      retryCount: number;
    };
  };
  'audit.completed': {
    data: {
      auditId: string;
      userId: string;
    };
  };
  'billing.payment_failed': {
    // C2 — PII discipline: do NOT include `customerEmail` in this payload.
    // The consumer (`send-payment-failed-email`) re-fetches the profile by
    // `userId` and reads `email` from the profile row, which is the source
    // of truth and avoids persisting the email in Inngest event history.
    data: {
      userId: string;
      stripeCustomerId: string;
      invoiceId: string | null;
      amountDueCents: number | null;
    };
  };
  'contract.uploaded': {
    data: {
      contractId: string;
      userId: string;
      storagePath: string;
    };
  };
  'finding.status_changed': {
    // Fired when a finding's status transitions, either via the authed
    // /api/audits/[id]/findings/[findingId]/status route or the
    // /api/inbound/finding-status callback. The dispatch-finding-webhook
    // consumer POSTs to the user's outbound webhook URL if configured.
    //
    // PII: rule_id / severity / title / cents only. No MDNs, no emails.
    data: {
      auditId: string;
      findingId: string;
      status: string;
      previousStatus: string | null;
      userId: string;
    };
  };
  'finding.created': {
    // Fired when a high-severity finding is created via the autopsy escalate
    // route. (Rule-runner persistence does NOT currently emit this event —
    // the starter scope intentionally keeps the chokepoint to a single
    // user-initiated site. See HANDOFF + send-slack-notification.ts.)
    //
    // The Slack notifier listens on this event and skips when
    // `severity !== 'high'` or the user has Slack disabled.
    //
    // PII: rule_id / severity / title / cents only.
    data: {
      auditId: string;
      findingId: string;
      userId: string;
      severity: string;
      ruleId: string;
      title: string;
      estimatedMonthlySavingsCents: number | null;
    };
  };
  'bill.comparison_persisted': {
    // Fired after `persistComparison` succeeds in src/autopsy/persist.ts.
    // The Slack notifier listens for this and skips when the comparison has
    // no disputable cents (the gate is: notify only when there's actually
    // something to act on).
    //
    // PII: cent totals + driver counts only. No driver titles in the event
    // (the dispatcher loads them from the DB fresh).
    data: {
      comparisonId: string;
      userId: string;
      previousAuditId: string;
      currentAuditId: string;
      disputableCents: number;
      netChangeCents: number;
      driversCount: number;
    };
  };
};

export const inngest = new Inngest({
  id: 'carrieraudit',
  // Optional in dev — the Inngest dev server does not require an event key.
  eventKey: env.INNGEST_EVENT_KEY,
  schemas: new EventSchemas().fromRecord<Events>(),
});
