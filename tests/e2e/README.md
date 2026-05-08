# Playwright E2E tests

This directory holds Playwright specs. Two tiers:

| Spec | Runs in CI? | What it covers |
| --- | --- | --- |
| `landing.spec.ts` | yes | Public marketing surface (auth-free). |
| `health.spec.ts` | yes | `GET /api/health` returns `{ status, checks }`. |
| `happy-path.spec.ts` | **no — gated behind `RUN_FULL_E2E=1`** | Full signup → buy → upload → report → share path against a real sandbox. |

Default: `pnpm test:e2e` runs only the public-surface specs. The full happy-path is `test.skip()`'d unless `RUN_FULL_E2E=1` is set, so CI stays green without sandbox credentials.

## happy-path.spec.ts

Phase 5 task #11 from `CLAUDE.md`. Walks the entire conversion funnel against a live sandbox.

### Why it's skipped by default

It needs real services: Supabase auth + DB, Stripe Checkout (test mode), Anthropic for extraction, and a running Inngest dev worker. None of those run in CI, so the spec gates itself with `RUN_FULL_E2E=1` and the `test.describe.skip` swap at the top of the file. The file is safe to load with no env set — none of the helpers in `setup.ts` build a Supabase client at import time.

### What you need before you run it

1. **A clean Supabase project** with every migration in `supabase/migrations/` applied (`0001_init.sql`, `0002_storage.sql`, `0003_reports_storage.sql`, `0004_billing_helpers.sql`). The `bills` and `reports` storage buckets must exist as private buckets.
2. **Stripe in test mode** with the same prices as prod ($149 one-time and $99/mo subscription), and `STRIPE_PRICE_ID_ONE_TIME` / `STRIPE_PRICE_ID_SUBSCRIPTION` set in the dev server's `.env.local`. Plan to clean up the test customer manually if you want a tidy dashboard.
3. **An Anthropic API key** in the dev server env (`ANTHROPIC_API_KEY`). The spec waits up to 5 minutes for `/api/audits/[id]/status` to return `completed`, which depends on the worker actually completing the extraction.
4. **The Inngest dev server** running in another terminal: `pnpm dlx inngest-cli@latest dev`. Without it the `bill.uploaded` event never fires, the audit hangs at `pending`, and the spec times out at step (f).
5. **The Next dev server** running on `http://localhost:3000`. The Playwright config (`playwright.config.ts`) starts it automatically via `pnpm dev`, but feel free to start it manually if you want to inspect logs.
6. **A small synthetic PDF** at `tests/fixtures/e2e-sample.pdf`. Another agent generates the canonical fixture(s); if it's missing the spec calls `test.skip()` in `beforeAll` instead of failing.

### Required env vars

| Var | Required | Purpose |
| --- | --- | --- |
| `RUN_FULL_E2E` | yes (`=1`) | Toggles the gated `test.describe.skip` → `test.describe`. |
| `E2E_SUPABASE_URL` | yes | Same value as `NEXT_PUBLIC_SUPABASE_URL`; renamed for clarity in the spec. Falls back to `NEXT_PUBLIC_SUPABASE_URL` if unset. |
| `E2E_SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key for the admin API; used to confirm the test user without clicking the magic link. |
| `E2E_STRIPE_TEST_CARD` | no (default `4242424242424242`) | Override the card number if you need to exercise a different Stripe test card. |
| `E2E_CLEANUP` | no (`=1` to enable) | Deletes the test user (cascading to profiles + audits + findings) in `afterAll`. Stripe customers are not auto-deleted. |

### How to run

In three terminals (the third is where you run the spec):

```bash
# terminal 1 — Next dev server
pnpm dev

# terminal 2 — Inngest dev worker
pnpm dlx inngest-cli@latest dev

# terminal 3 — the gated spec
RUN_FULL_E2E=1 \
  E2E_SUPABASE_URL=https://<project>.supabase.co \
  E2E_SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  pnpm test:e2e tests/e2e/happy-path.spec.ts
```

Add `E2E_CLEANUP=1` if you want the test user deleted after the run.

### Expected duration

Roughly **3 to 5 minutes** per run. Most of that is the Anthropic extraction step (~1–3 min) and the Stripe Checkout redirect dance. The other steps are seconds.

### Known limitations

- **Stripe Checkout is iframe-isolated.** Playwright handles the hosted page by filling the named inputs (`cardNumber`, `cardExpiry`, `cardCvc`, `billingName`) directly. If Stripe ships a redesigned form the selectors in step (d) will break — update them and link the diff back here.
- **The clipboard read in step (i)** requires `clipboard-read` permission, which Playwright grants in-context. Headed runs work too. If you run with a different browser project add the same `grantPermissions` call.
- **No Stripe customer cleanup.** Test-mode customers accumulate; delete them from the Stripe dashboard if it gets noisy.
- **Concurrent runs** generate distinct `e2e+<timestamp>-<rand>@carrieraudit.test` emails, so they won't collide on signup. They will collide on Stripe rate limits if you spam them.
