-- Share-token expiry + retry counter for audit idempotency hardening.
alter table public.audits
  add column if not exists share_token_expires_at timestamptz,
  add column if not exists retry_count integer not null default 0;

-- A shared token without an expiry is grandfathered; new shares set explicit expiry.
-- retry_count starts at 0; the retry route CAS-increments it for stable Inngest idempotency keys.

create index if not exists audits_share_token_lookup_idx
  on public.audits(share_token)
  where share_token is not null;
