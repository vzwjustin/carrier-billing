-- CarrierAudit reports storage bucket
-- Source of truth: CLAUDE.md §6 Phase 3, task #2 (caching at reports/{auditId}.pdf)
--
-- The route handler at /api/audits/[id]/report.pdf is the ONLY way users
-- reach a generated report PDF. The bucket is private with no SELECT or
-- INSERT policy on storage.objects — service-role writes (from the route
-- handler running on the server) bypass RLS.

insert into storage.buckets (id, name, public)
  values ('reports', 'reports', false)
  on conflict (id) do nothing;

-- No INSERT/SELECT/UPDATE/DELETE policies on storage.objects for 'reports'.
-- Service role bypasses RLS by default; user-scope clients must not be
-- able to read or write to this bucket directly.
