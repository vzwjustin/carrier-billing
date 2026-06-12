import { serve } from 'inngest/next';

import { env } from '@/env';
import { inngest } from '@/inngest/client';
import { functions } from '@/inngest/functions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

if (
  process.env.NODE_ENV === 'production' &&
  process.env.SKIP_ENV_VALIDATION !== '1' &&
  !process.env.CI &&
  !env.INNGEST_SIGNING_KEY
) {
  throw new Error('INNGEST_SIGNING_KEY is required in production');
}

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...functions],
  signingKey: env.INNGEST_SIGNING_KEY,
});
