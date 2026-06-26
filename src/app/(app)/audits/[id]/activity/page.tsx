/**
 * /audits/[id]/activity
 *
 * Owner-only activity log for a single audit. Shows the 100 most recent
 * `audit_trail_events` rows that mention this audit — either directly (the
 * row's `entity_id` is the audit) or transitively (a finding/driver/
 * comparison event whose `metadata.audit_id` matches).
 *
 * Server component: a plain Supabase RLS-scoped read (the `own trail read`
 * policy in migration 0031 enforces owner-only visibility), no client-side
 * fetching, no realtime — the log is append-only so a refresh is enough.
 *
 * Empty-state copy applies to brand-new audits whose only "event" is the
 * upload itself — but even an upload writes a row, so the empty path is
 * mostly defensive (e.g. data created before migration 0031 was deployed).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';
import type { AuditTrailEventType } from '@/lib/audit-trail/log';

export const metadata = {
  title: 'Activity — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface AuditRow {
  id: string;
  user_id: string;
  original_filename: string;
}

interface TrailRow {
  id: string;
  event_type: AuditTrailEventType;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  actor_email: string | null;
  created_at: string;
}

const EVENT_LABEL: Record<AuditTrailEventType, string> = {
  audit_uploaded: 'Audit uploaded',
  audit_completed: 'Audit completed',
  finding_status_changed: 'Finding status changed',
  finding_escalated: 'Finding escalated',
  autopsy_run: 'Autopsy run',
  driver_marked_explained: 'Driver marked explained',
  contract_uploaded: 'Contract uploaded',
  contract_terms_edited: 'Contract terms edited',
  report_downloaded: 'Report downloaded',
  dispute_packet_generated: 'Dispute packet generated',
  csv_exported: 'CSV exported',
};

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const deltaSeconds = Math.floor((Date.now() - ts) / 1000);
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const m = Math.floor(deltaSeconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  // For old events fall back to the date; relative units get noisy past a month.
  return new Date(ts).toISOString().slice(0, 10);
}

export default async function AuditActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const resolved = await params;
  const parsed = ParamsSchema.safeParse(resolved);
  if (!parsed.success) {
    notFound();
  }
  const auditId = parsed.data.id;

  const supabase = await createClient();

  // Ownership check via the audits row — RLS on `audits` already requires
  // owner. A miss returns notFound() so we don't differentiate "wrong id"
  // from "not yours" to a probing caller.
  const { data: auditData, error: auditErr } = await supabase
    .from('audits')
    .select('id,user_id,original_filename')
    .eq('id', auditId)
    .maybeSingle<AuditRow>();
  if (auditErr || !auditData) {
    notFound();
  }

  // Two-arm read:
  //  - direct: `entity_id = auditId` (covers `audit_uploaded`,
  //    `audit_completed`, `report_downloaded`, `csv_exported`, and any
  //    `entity_type='audit'` events).
  //  - indirect: events whose entity is a finding/driver/comparison but
  //    whose metadata records the parent audit. The migration's CHECK
  //    constraint doesn't enforce metadata shape — callers in
  //    src/app/api/* set `metadata.audit_id` consistently.
  //
  // We do two queries instead of an OR because PostgREST's jsonb operator
  // support is awkward inside the SDK's filter builder; the union+sort
  // here is plenty fast at our 100-row ceiling.
  const [directRes, indirectRes] = await Promise.all([
    supabase
      .from('audit_trail_events')
      .select('id,event_type,entity_type,entity_id,metadata,actor_email,created_at')
      .eq('entity_id', auditId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('audit_trail_events')
      .select('id,event_type,entity_type,entity_id,metadata,actor_email,created_at')
      .in('entity_type', ['finding', 'driver', 'comparison'])
      .eq('metadata->>audit_id', auditId)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  if (directRes.error || indirectRes.error) {
    throw new Error('Failed to load activity log.');
  }

  // Merge + de-dupe by id, then sort descending and cap.
  const seen = new Set<string>();
  const events: TrailRow[] = [];
  for (const row of [
    ...((directRes.data ?? []) as TrailRow[]),
    ...((indirectRes.data ?? []) as TrailRow[]),
  ]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    events.push(row);
  }
  events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const recent = events.slice(0, 100);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/audits/${auditId}`}
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          ← Back to audit
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">Activity</h1>
        <p className="mt-1 max-w-xl truncate text-sm text-neutral-600">
          {auditData.original_filename}
        </p>
      </div>

      {recent.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500">
          No activity recorded yet for this audit.
        </div>
      ) : (
        <ul className="space-y-3">
          {recent.map((event) => (
            <li key={event.id} className="rounded-md border border-neutral-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
                  {EVENT_LABEL[event.event_type] ?? event.event_type}
                </span>
                <span className="text-xs text-neutral-500" title={event.created_at}>
                  {relativeTime(event.created_at)}
                </span>
              </div>
              {event.actor_email !== null ? (
                <p className="mt-2 text-xs text-neutral-600">by {event.actor_email}</p>
              ) : null}
              {event.metadata !== null && Object.keys(event.metadata).length > 0 ? (
                <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-2 text-[11px] break-words whitespace-pre-wrap text-neutral-700">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
