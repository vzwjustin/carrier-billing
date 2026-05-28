/**
 * Inbound webhook token — client-safe shape + display helpers.
 *
 * Split from `webhook-token.ts` so client components (the settings page
 * uses `maskInboundWebhookToken` in a `'use client'` card) can import the
 * pure helpers without dragging `node:crypto` into the browser bundle.
 * Server-only `generateInboundWebhookToken` lives in `webhook-token.ts`.
 */

export const INBOUND_WEBHOOK_TOKEN_LENGTH = 32;

const INBOUND_WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/**
 * Shape-only check — does NOT verify the token exists in the DB. Used as a
 * cheap pre-flight on inbound requests so we don't dispatch DB queries for
 * obviously malformed tokens (brute-force absorption).
 */
export function isInboundWebhookTokenShape(value: unknown): value is string {
  return typeof value === 'string' && INBOUND_WEBHOOK_TOKEN_RE.test(value);
}

/**
 * Mask all but the last 6 chars of a token for display. Used by the
 * integrations settings page so the UI can show a partial token without
 * leaking the full value into HTML (or DOM snapshots, etc.) until the user
 * explicitly clicks Reveal.
 */
export function maskInboundWebhookToken(token: string): string {
  if (token.length <= 6) return '••••••';
  return `${'•'.repeat(token.length - 6)}${token.slice(-6)}`;
}
