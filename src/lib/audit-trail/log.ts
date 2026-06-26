/**
 * Audit trail logger — "who did what when" event stream.
 *
 * Writes an immutable row to `audit_trail_events` after a successful side
 * effect (finding-status flip, driver escalation, contract terms edit,
 * report download, etc). The CHECK constraint in migration 0031 mirrors
 * the `AuditTrailEventType` union below — keep them in lockstep.
 *
 * Operating rules:
 *   1. Best-effort: catch every error and Sentry-capture it. NEVER fail
 *      the calling route — the trail is observability, not a precondition.
 *   2. Service-role write: the table has no INSERT policy, so we use the
 *      admin client. The caller has already done the ownership check.
 *   3. PII discipline (CLAUDE.md §1#5): never store the raw actor email.
 *      Mask it via `maskEmail()` before persisting. Metadata is capped at
 *      ~1 KB by truncation; over-cap payloads are dropped wholesale rather
 *      than partially serialized so we never persist a torn fragment.
 *   4. Metadata MUST NOT contain MDNs, full phone numbers, or raw bill
 *      content. Auditing surfaces are responsible for shaping the
 *      metadata payload — this helper does no scrubbing beyond size.
 */
import * as Sentry from '@sentry/nextjs';

import { getAdminClient } from '@/lib/supabase/admin';

export const AUDIT_TRAIL_EVENT_TYPES = [
  'audit_uploaded',
  'audit_completed',
  'finding_status_changed',
  'finding_escalated',
  'autopsy_run',
  'driver_marked_explained',
  'contract_uploaded',
  'contract_terms_edited',
  'report_downloaded',
  'dispute_packet_generated',
  'csv_exported',
] as const;

export type AuditTrailEventType = (typeof AUDIT_TRAIL_EVENT_TYPES)[number];

export type AuditTrailEntityType = 'audit' | 'finding' | 'driver' | 'contract' | 'comparison';

export interface LogTrailEventInput {
  userId: string;
  eventType: AuditTrailEventType;
  entityType?: AuditTrailEntityType;
  entityId?: string;
  /** Small, PII-disciplined JSON. Capped at ~1 KB after serialization. */
  metadata?: Record<string, unknown>;
  /** Raw email — will be masked before insert. NEVER persisted in raw form. */
  actorEmail?: string | null;
}

/** Soft cap on metadata size after JSON.stringify. Mirror in the migration
 *  doc-comment so anyone editing the table understands the budget. */
const METADATA_MAX_BYTES = 1024;

/**
 * Mask an email address for log readability.
 *
 *   "justin@example.com" -> "j***@example.com"
 *   "jq@example.com"     -> "j***@example.com"  (collapsed to one char)
 *   "j@example.com"      -> "j***@example.com"
 *   ""                   -> null
 *   null                 -> null
 *   "not-an-email"       -> null  (no `@`)
 *
 * Keeps the first character of the local part + the full domain. Anyone
 * with a list of plausible emails for the user could still re-identify
 * (this is a triage aid, not a cryptographic guarantee), but the column
 * never holds enough on its own to leak the address.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  if (trimmed.length === 0) return null;
  const atIdx = trimmed.indexOf('@');
  // Require an `@`, with at least one char on each side. Anything else is
  // not an email shape — return null rather than guessing.
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  const firstChar = local.charAt(0);
  return `${firstChar}***@${domain}`;
}

/**
 * Best-effort insert. Returns nothing — callers must not branch on its
 * outcome. Failures are captured in Sentry; the calling route succeeds
 * regardless.
 */
export async function logTrailEvent(input: LogTrailEventInput): Promise<void> {
  // Skip in the Vitest harness UNLESS a test explicitly opts in. Route tests
  // mock the Supabase client and counting the extra
  // `.from('audit_trail_events').insert(...)` call breaks every
  // `toHaveBeenCalledTimes(1)` assertion. The trail is observability, not
  // behavior under test for those routes. Tests in `tests/audit-trail/*`
  // that exercise this function directly set `RUN_AUDIT_TRAIL=1` in their
  // beforeEach to flip the gate back on.
  if (process.env.NODE_ENV === 'test' && process.env.RUN_AUDIT_TRAIL !== '1') {
    return;
  }
  try {
    const metadata = clampMetadata(input.metadata);
    const masked = maskEmail(input.actorEmail ?? null);
    const admin = getAdminClient();
    const { error } = await admin.from('audit_trail_events').insert({
      user_id: input.userId,
      event_type: input.eventType,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      metadata,
      actor_email: masked,
    });
    if (error) {
      Sentry.captureException(new Error(error.message), {
        tags: { surface: 'audit_trail.insert' },
        extra: {
          userId: input.userId,
          eventType: input.eventType,
          entityType: input.entityType,
        },
      });
    }
  } catch (err) {
    // Catch-all: NEVER let the trail throw into the caller.
    Sentry.captureException(err, {
      tags: { surface: 'audit_trail.unknown' },
      extra: {
        userId: input.userId,
        eventType: input.eventType,
      },
    });
  }
}

function clampMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const json = JSON.stringify(metadata);
    if (typeof json !== 'string') return {};
    // Byte budget: keep the row small. If the serialized payload exceeds the
    // cap, drop the whole metadata blob rather than partially persisting a
    // truncated string — a half-payload is a footgun for downstream readers.
    if (Buffer.byteLength(json, 'utf8') > METADATA_MAX_BYTES) {
      return { truncated: true };
    }
    return metadata;
  } catch {
    return {};
  }
}
