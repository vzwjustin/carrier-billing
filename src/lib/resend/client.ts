// Lazy Resend client — constructed on first send so build doesn't crash without keys.
import { Resend } from 'resend';

import { env } from '@/env';

let cached: Resend | null = null;

export function getResend(): Resend {
  if (cached) return cached;
  cached = new Resend(env.RESEND_API_KEY);
  return cached;
}
