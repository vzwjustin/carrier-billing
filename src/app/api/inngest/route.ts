import { serve } from 'inngest/next';

import { env } from '@/env';
import { inngest } from '@/inngest/client';
import { functions } from '@/inngest/functions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...functions],
  signingKey: env.INNGEST_SIGNING_KEY,
});
