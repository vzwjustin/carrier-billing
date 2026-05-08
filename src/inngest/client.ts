import { EventSchemas, Inngest } from 'inngest';

import { env } from '@/env';

/**
 * Typed event registry for the CarrierAudit Inngest client.
 *
 * Add new events here as they are introduced. The shape is
 * `{ data: <payload> }` per the Inngest typed-events API.
 */
export type Events = {
  'demo/hello': {
    data: {
      name?: string;
    };
  };
  'bill.uploaded': {
    data: {
      auditId: string;
      userId: string;
      storagePath: string;
    };
  };
};

export const inngest = new Inngest({
  id: 'carrieraudit',
  // Optional in dev — the Inngest dev server does not require an event key.
  eventKey: env.INNGEST_EVENT_KEY,
  schemas: new EventSchemas().fromRecord<Events>(),
});
