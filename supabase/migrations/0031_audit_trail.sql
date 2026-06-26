-- 0031 — Audit trail / activity log.
--
-- Per-user "who did what when" event stream. Drives the audit detail page's
-- /activity tab and gives operators a forensic record of every meaningful
-- write surface (upload, finding-status flip, driver escalation/explain,
-- contract terms edit, report download, CSV export).
--
-- Design notes
-- ------------
-- 1. `entity_id` is FK-free. The set of entity types is wide
--    (audit/finding/driver/contract/comparison) and several of those tables
--    cascade-delete the audit. Wiring a hard FK would force trail rows to
--    disappear with the parent — which is exactly the opposite of what an
--    audit log should do. We keep the column nullable + indexed and resolve
--    the parent (if it still exists) at read time.
-- 2. `actor_email` is the MASKED form only (`j***@example.com`). Per the
--    project's PII discipline (CLAUDE.md §1#5) we never store the raw email.
--    A trigger/CHECK could enforce the `***@` shape but the surface area is
--    a single helper in `src/lib/audit-trail/log.ts` — the application-side
--    guard is the primary gate; the DB column is just a string.
-- 3. The log is immutable: no updated_at trigger, no UPDATE policy. Writes
--    are service-role only, reads are owner-only.
-- 4. `metadata` is capped at ~1 KB by convention in the logger (CLAUDE.md
--    §1#5 — PII discipline + small payload size). We do not enforce the
--    size in the DB; if a future caller blows past 1 KB we'd rather see the
--    row than reject the write and lose the audit trail entry.
--
-- All changes are forward-only and additive — no other tables touched.

create table if not exists public.audit_trail_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  -- MASKED form only (e.g. `j***@example.com`). NEVER store raw email here.
  actor_email text,
  created_at timestamptz not null default now()
);

-- CHECK constraint mirrors the literal-union in
-- src/lib/audit-trail/log.ts:AuditTrailEventType. If you add an event type
-- here you MUST add it there too. The CHECK is belt-and-suspenders against
-- a misspelled event_type that bypasses the application-side enum (mirrors
-- the pattern in migration 0023).
alter table public.audit_trail_events
  add constraint audit_trail_events_event_type_check
    check (event_type in (
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
      'csv_exported'
    ));

-- Indexes
-- (a) Per-user reverse-chrono scan — the activity page's primary query.
create index if not exists audit_trail_events_user_created_idx
  on public.audit_trail_events(user_id, created_at desc);

-- (b) Entity-scoped lookup — the activity page filters by audit/finding/
--     driver id. Partial because the table will accumulate metadata-only
--     events (no entity_id) and we don't want them in the index.
create index if not exists audit_trail_events_user_entity_idx
  on public.audit_trail_events(user_id, entity_type, entity_id)
  where entity_id is not null;

-- RLS — owner reads, service-role writes only.
alter table public.audit_trail_events enable row level security;

drop policy if exists "own trail read" on public.audit_trail_events;
create policy "own trail read" on public.audit_trail_events
  for select using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy: writes flow exclusively through the
-- service-role admin client inside the logger helper. Operators with the
-- service role intentionally bypass RLS to write the row.
