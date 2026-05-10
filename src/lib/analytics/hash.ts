/**
 * Server-only helper for turning a public share token into an analytics
 * distinctId. PostHog stores (event, distinctId) tuples permanently, so
 * sending the raw token would leak credentials granting share access into
 * a third-party system. Hashing with SHA-256 + truncation gives a stable
 * id for repeat-visit attribution while making the original token
 * unrecoverable from analytics data.
 *
 * Imports `node:crypto` — never import this module from a client component.
 */
import { createHash } from 'node:crypto';

export function hashTokenForAnalytics(token: string): string {
  return `share_${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}
