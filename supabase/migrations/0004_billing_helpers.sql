-- Phase 4: helpers used by the Stripe webhook handler.
--
-- `increment_audit_credits(profile_id, delta)` performs an atomic
-- read-modify-write on `profiles.audit_credits`. We expose this as a SECURITY
-- DEFINER function so it can be called via PostgREST/RPC from the service-role
-- client without RLS getting in the way, while still being safe (the function
-- only mutates a single column on a single row).
--
-- Idempotency: this function is safe to call once per Stripe event because the
-- caller (the webhook) gates calls behind the `billing_events.stripe_event_id`
-- unique constraint. Replay of the same Stripe event is short-circuited before
-- this RPC runs.

drop function if exists public.increment_audit_credits(uuid, int);

create or replace function public.increment_audit_credits(profile_id uuid, delta int)
returns int
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set audit_credits = audit_credits + delta,
         updated_at = now()
   where id = profile_id
  returning audit_credits;
$$;
