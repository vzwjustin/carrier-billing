-- 0036 — Contract worker self-replay support (bug hunt #6)
--
-- process-contract had no inngest_run_id column, so it could not implement
-- process-bill's C1 self-replay branch: if a worker committed the
-- pending→extracting flip but crashed before Inngest persisted the step
-- result, the retry saw status='extracting', matched 0 rows in mark-extracting,
-- and exited as "already-advanced" without extracting — stranding the contract
-- in 'extracting' forever (no sweeper covers contracts).
--
-- Adding inngest_run_id lets mark-extracting stamp its run id on the flip and
-- recognize its own committed write on replay. Additive + nullable; no backfill.

alter table public.contracts
  add column if not exists inngest_run_id text;

-- #14: re-extract used a Date.now() idempotency key, so Inngest never deduped
-- concurrent /start clicks (each got a unique id). A static key would instead
-- block a legitimate later re-extract for ~24h. A monotonic per-contract
-- attempt counter gives a stable key for one re-extract that still advances for
-- the next, so concurrent double-clicks collapse but sequential re-runs don't.
alter table public.contracts
  add column if not exists extract_attempt integer not null default 0;
