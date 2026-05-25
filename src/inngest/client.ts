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
};

export const inngest = new Inngest({
  id: 'carrieraudit',
  // Optional in dev — the Inngest dev server does not require an event key.
  eventKey: env.INNGEST_EVENT_KEY,
  schemas: new EventSchemas().fromRecord<Events>(),
});
