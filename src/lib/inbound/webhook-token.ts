/**
 * Inbound HTTP webhook token utilities — server-only.
 *
 * Pure helpers (`isInboundWebhookTokenShape`, `maskInboundWebhookToken`,
 * `INBOUND_WEBHOOK_TOKEN_LENGTH`) live in `./webhook-token-shape.ts` so
 * client components can import them without pulling `node:crypto` into
 * the browser bundle. Re-exported here to keep the existing import path
 * working for server-side callers.
 */
import { randomBytes } from 'node:crypto';

export {
  INBOUND_WEBHOOK_TOKEN_LENGTH,
  isInboundWebhookTokenShape,
  maskInboundWebhookToken,
} from './webhook-token-shape';

const INBOUND_WEBHOOK_TOKEN_BYTES = 24;

export function generateInboundWebhookToken(): string {
  return randomBytes(INBOUND_WEBHOOK_TOKEN_BYTES).toString('base64url');
}
