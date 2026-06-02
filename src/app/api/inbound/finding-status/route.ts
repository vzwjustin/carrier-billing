/**
 * Inbound finding-status webhook.
 *
 * Authenticated by an `X-CarrierAudit-Token: <inbound_webhook_token>` header
 * that maps 1:1 to a user via the `profiles.inbound_webhook_token` unique
 * partial index (migration 0029). The token is the only credential — no body
 * signature is required because the token IS the secret.
 *
 * Body:
 *   { audit_id: uuid, finding_id: uuid, status: <enum>, note?: string ≤500 }
 *
 * Behaviour:
 *   1. Reject if the header is missing or shape-invalid (constant-time format
 *      check; we don't pass arbitrary tokens to the DB).
 *   2. Apply pre-auth public throttles and a 16 KiB body cap before JSON
 *      parsing or profile lookup.
 *   3. Look up the profile by token. Unknown → 401. We never echo the token
 *      back to the caller and we never log it.
 *   4. Per-profile rate limit (120/min).
 *   5. Confirm the (audit, finding) pair belongs to this profile. Mismatched
 *      ownership → 404 (not 403, so we don't leak the existence of other
 *      users' audits to a token holder).
 *   6. Update via admin client (mirrors the authed status route).
 *   7. Fire `finding.status_changed` so the dispatcher pushes the change back
 *      out to any configured outbound webhook. Inngest-send failure does NOT
 *      fail the response — the DB write already happened.
 *
 * Logs only ever carry {auditId, findingId, status}. Never the token, never
 * the note, never email/MDN content.
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { FINDING_STATUS_VALUES } from '@/components/report/finding-status-meta';
import { inngest } from '@/inngest/client';
import { isInboundWebhookTokenShape } from '@/lib/inbound/webhook-token';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import type { FindingStatus } from '@/rules/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REQUEST_BYTES = 16 * 1024;

const STATUS_ENUM = FINDING_STATUS_VALUES as readonly [FindingStatus, ...FindingStatus[]];

const BodySchema = z.object({
  audit_id: z.string().uuid(),
  finding_id: z.string().uuid(),
  status: z.enum(STATUS_ENUM),
  note: z.string().max(500).optional(),
});

interface ProfileTokenRow {
  id: string;
}

interface FindingPreImageRow {
  id: string;
  audit_id: string;
  status: FindingStatus;
  audits: { id: string; user_id: string } | null;
}

function unauthorized(): Response {
  return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
}

function hashForRateLimit(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function getClientBucket(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const clientIp = forwardedFor?.split(',')[0]?.trim();
  const source =
    clientIp ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    'unknown';
  return hashForRateLimit(source);
}

async function readRawBodyWithLimit(request: Request, limitBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) return null;
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function POST(request: Request): Promise<Response> {
  // 1. Token header — shape check first so a bogus token never even hits
  // the DB. The CHECK constraint at the column would also reject it, but
  // skipping the round-trip keeps brute-force attempts cheap to absorb.
  const token = request.headers.get('x-carrieraudit-token');
  if (!isInboundWebhookTokenShape(token)) {
    return unauthorized();
  }

  let auditId: string | null = null;
  let findingId: string | null = null;

  try {
    // 2. Pre-auth throttles and body cap. These run before JSON parsing and
    // before the token→profile lookup, so shape-valid unknown tokens can't
    // force unlimited admin queries or unbounded body reads.
    const publicSourceLimit = await consumeRateLimit({
      key: `inbound-finding-status-public-source:${getClientBucket(request)}`,
      limit: 600,
      windowSeconds: 60,
    });
    if (!publicSourceLimit.ok) {
      return rateLimitedResponse(publicSourceLimit.resetAt);
    }

    const publicTokenLimit = await consumeRateLimit({
      key: `inbound-finding-status-public-token:${hashForRateLimit(token)}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (!publicTokenLimit.ok) {
      return rateLimitedResponse(publicTokenLimit.resetAt);
    }

    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (
        !Number.isFinite(contentLength) ||
        contentLength < 0 ||
        contentLength > MAX_REQUEST_BYTES
      ) {
        return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
      }
    }

    const rawBody = await readRawBodyWithLimit(request, MAX_REQUEST_BYTES);
    if (rawBody === null) {
      return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
    }

    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const { status, note } = parsed.data;
    auditId = parsed.data.audit_id;
    findingId = parsed.data.finding_id;

    const admin = getAdminClient();

    // 3. Token → profile lookup. Unknown token surfaces as 401 with the same
    // body shape as a shape-invalid token, so a probe can't distinguish
    // "wrong format" from "unknown" without out-of-band knowledge.
    const { data: profileData, error: profileErr } = await admin
      .from('profiles')
      .select('id')
      .eq('inbound_webhook_token', token)
      .maybeSingle();
    if (profileErr) {
      Sentry.captureException(profileErr, {
        tags: { surface: 'inbound_finding_status.profile_lookup' },
      });
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
    }
    const profile = (profileData ?? null) as ProfileTokenRow | null;
    if (!profile) {
      return unauthorized();
    }

    // 4. Rate limit AFTER auth so a misconfigured caller hammering with a
    // valid token can't lock themselves out by tripping a per-IP bucket they
    // share with other tenants. Per-token bucket is the right granularity.
    const limit = await consumeRateLimit({
      key: `inbound-finding-status:${profile.id}`,
      limit: 120,
      windowSeconds: 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    // 5. Ownership check. RLS would catch this for anon/authed clients but
    // we're using the service-role admin client, so the check has to live
    // in code.
    const { data: findingData, error: findingErr } = await admin
      .from('findings')
      .select('id,audit_id,status,audits!inner(id,user_id)')
      .eq('id', findingId)
      .eq('audit_id', auditId)
      .maybeSingle<FindingPreImageRow>();
    if (findingErr) {
      Sentry.captureException(findingErr, {
        tags: { surface: 'inbound_finding_status.finding_lookup' },
        extra: { auditId, findingId },
      });
      return NextResponse.json({ error: 'Failed to look up finding.' }, { status: 500 });
    }
    if (!findingData) {
      return NextResponse.json({ error: 'Finding not found.' }, { status: 404 });
    }
    if (!findingData.audits || findingData.audits.user_id !== profile.id) {
      // Don't 403 — 404 keeps existence of other users' audits secret.
      return NextResponse.json({ error: 'Finding not found.' }, { status: 404 });
    }

    const previousStatus = findingData.status;

    // 6. Update. Same column set as the authed route. `status_updated_by`
    // points at the profile owner — an inbound update is performed *on
    // behalf of* the user, and the column has a FK to auth.users.
    const { error: updateError } = await admin
      .from('findings')
      .update({
        status,
        status_updated_at: new Date().toISOString(),
        status_updated_by: profile.id,
        review_note: note ?? null,
      })
      .eq('id', findingId)
      .eq('audit_id', auditId);

    if (updateError) {
      Sentry.captureException(updateError, {
        tags: { surface: 'inbound_finding_status.update' },
        extra: { auditId, findingId, status },
      });
      return NextResponse.json({ error: 'Failed to update finding.' }, { status: 500 });
    }

    // 7. Fire the same event the authed route fires. Best-effort.
    try {
      await inngest.send({
        id: `finding-${findingId}-${status}`,
        name: 'finding.status_changed',
        data: {
          auditId,
          findingId,
          status,
          previousStatus,
          userId: profile.id,
        },
      });
    } catch (sendErr) {
      Sentry.captureException(sendErr, {
        tags: { surface: 'inbound_finding_status.event_send' },
        extra: { auditId, findingId, status },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: 'inbound_finding_status.unknown' },
      extra: { auditId, findingId },
    });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
