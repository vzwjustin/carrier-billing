import Stripe from 'stripe';
import { env } from '@/env';

/**
 * Lazy server-side Stripe client.
 *
 * Constructed on first access so missing keys at build time (or in tests)
 * don't crash module evaluation. The webhook route + checkout route are the
 * only callers in Phase 0.
 */
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-02-24.acacia',
    typescript: true,
    appInfo: {
      name: 'CarrierAudit',
      version: '0.1.0',
    },
  });
  return cached;
}
