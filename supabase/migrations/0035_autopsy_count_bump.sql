-- 0035 — Atomic audit finding-count bump (bug hunt #5)
--
-- The autopsy-escalate route bumped audits.finding_count / high_severity_count
-- with a read-modify-write (SELECT counts, then UPDATE counts+1). Two drivers
-- on the same audit escalated concurrently both read the same baseline and one
-- increment is lost. This RPC performs the increment as a single atomic SQL
-- UPDATE so concurrent escalations compose correctly.
--
-- Service-role only (called from the escalate route via the admin client).

create or replace function public.bump_audit_finding_counts(
  p_audit_id uuid,
  p_high_delta int
) returns void
language sql
security definer
set search_path = public
as $$
  update public.audits
     set finding_count = coalesce(finding_count, 0) + 1,
         high_severity_count = coalesce(high_severity_count, 0) + p_high_delta,
         updated_at = now()
   where id = p_audit_id;
$$;

revoke all on function public.bump_audit_finding_counts(uuid, int) from public;
grant execute on function public.bump_audit_finding_counts(uuid, int) to service_role;
