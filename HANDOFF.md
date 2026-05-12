# CarrierAudit — Handoff for next Claude session

> **Next.js 15 SaaS** (`CarrierAudit`) — business wireless bill PDF → extraction → rules → savings report.
> **Canonical product spec:** [`SPEC.md`](./SPEC.md). **Operator setup:** [`README.md`](./README.md). **Agent context:** [`CLAUDE.md`](./CLAUDE.md) (or [`AGENTS.md`](./AGENTS.md) for Codex).
>
> Phases 0–4 are shipped. Phase 5 (launch polish) is **partially** done — use the sections below; do not rely on older chat summaries if they conflict with this file.

---

## Most recent pass (2026-05-11): extreme-analysis remediation

A full audit-and-fix pass landed 3 CRITICAL, 11 HIGH, 10 MEDIUM, and 7 LOW
remediations plus 5 new rules. Highlights:

### Critical
- **C1** — Permanent credit loss on first-attempt `increment_audit_credits`
  failure is closed. New atomic `grant_credit_once(event_id, profile_id, delta)`
  RPC + `billing_events.credit_granted boolean` (migration **0017**). Handler
  now gates on `credit_granted IS NOT TRUE` so retries can re-attempt the
  grant indefinitely. Replay cron passes `billingEventId` through.
- **C2** — Three `update(...)` bookkeeping writes in `replay-billing-events.ts`
  no longer swallow errors. Each now throws on `.error`, so a flapping DB
  cannot leave a row stuck claiming success while the cron silently
  reprocesses it forever.
- **C3 (operator)** — Resend sender domain (`reports@carrieraudit.com` in
  `src/lib/resend/from.ts`) is still unset; DNS / verification work is the
  remaining launch blocker — code path is correct.

### High
- **H1+H2** — `expired_promo_credit` rewritten: filters non-`is_promo` rows
  (was false-firing on ops adjustments) and the description no longer
  claims the discount is missing from this bill.
- **H3** — `account_level_promo_about_to_expire` now also walks per-line
  credits in the 31–60d window. The 36-month device-payoff promo gap is
  closed.
- **H4** — `/api/health` gains a deep-mode check (`?token=<HEALTH_SECRET>`)
  for DB + Stripe + Anthropic-presence; liveness behavior unchanged for
  anon callers. New optional `HEALTH_SECRET` env var.
- **H5** — `translateLineIndexes` now collects drop counts; emitted as a
  Sentry breadcrumb at `persist-findings`.
- **H6** — `profiles.cancel_at_period_end` + `current_period_end` columns
  in migration **0017**. Handler reads them from `Stripe.Subscription`.
  `/settings/billing` renders a "cancellation scheduled" notice with the
  period-end date.
- **H7** — Rule errors keep their original stack frame (was overwriting
  with `runner.ts:64`).
- **H8** — Anthropic call wrapped in 3-attempt exponential-backoff retry
  on 429/500/502/503/504/529.
- **H9** — PDF cache-write `upload` errors now `Sentry.captureException`.
- **H10** — `user_label` Zod transform redacts two-or-more-capitalized-word
  patterns. Prompt instruction also added.
- **H11** — `assertExactlyOneProfileMatched` returns a `NO_MATCH` sentinel
  for terminal events (`customer.subscription.deleted`,
  `invoice.payment_failed`) when the profile is gone. No more 13× Sentry
  warning per deleted user.

### Medium
- **M1** — Stripe checkout orphan-customer cleanup `swallow`s now
  `Sentry.captureException` with scrubbed message.
- **M3** — `unused_mifi_or_jetpack_line` capped at `severity: 'low'` until
  schema carries an activation date.
- **M4** — Verizon Pro 2.0 removed from `PLAN_SOFT_CAPS_GB`; it has no
  premium-data cap.
- **M5** — `legacy_unlimited_plan` strips `replacement_plan` and drops
  confidence when carrier is `'unknown'`.
- **M6** — `duplicate_protection_features` savings now `total - max` (drop
  cheapest) — conservative vs. the prior optimistic `total - min`.
- **M7** — `orphan_insurance` zombie heuristic uses `?? 0` on
  `plan_base_cents` so null bases count.
- **M8** — `detect.ts` AT&T regex now requires a carrier-context keyword.
- **M11** — Inngest event payloads Zod-parsed at the boundary
  (`src/inngest/events.ts`). All three consumers wired up.
- **M13** — Literal unions for `AuditStatus`, `AuditCarrier`,
  `FindingSeverity`, `SubscriptionStatus` in `src/types/db-enums.ts`.
  Applied at gate.ts and dispatch-outbound-webhook.ts.
- **M16** — Inngest-send failure in `onInvoicePaymentFailed` captured at
  `level: 'error'` (alertable).

### Low
- **L3** — `dangerouslySetInnerHTML` on the static `&mdash;` in
  `src/app/page.tsx` is gone.
- **L5** — Rate-limit added to `/api/audits/[id]/status` (60/min/user) and
  `/api/audits/[id]/report.pdf` (10/5m public, 30/5m auth).
- **L6** — Bad LLM raw output `scrubString`-redacted before echoing on retry.
- **L7** — `stale_international_feature` now emits a single per-bill
  rolled-up finding (was one per line, each $0).
- **L9** — `cleanup-orphan-audits` filters on `credit_consumed = true` at
  the query layer (defense-in-depth on the RPC guard).
- **L10** — Stripe portal route handles `resource_missing` 404 → returns
  409 to the client instead of a generic 500.

### New rules (F4–F8)
Five new rule files in `src/rules/definitions/`, all registered in
`registry.ts`:
- `insurance_after_device_payoff`
- `underutilized_phone_on_premium_plan`
- `disproportionate_taxes_fees`
- `activation_fee_on_existing_line`
- `stranded_cloud_storage`

### F5 — page_count UI warning
`audit-viewer.tsx` renders a "large bill — may take longer" notice when
`page_count > 100`. Status route + page server-load both surface it.

### Migration 0017
**Deploy order:** apply
`supabase/migrations/0017_credit_grant_atomic_and_subscription_lifecycle.sql`
**before** deploying any commit that imports the updated handlers.ts. New
columns are additive + nullable. Without 0017 the handler will throw
`column credit_granted does not exist` on the next Stripe one-time event,
and the billing page will fail to read `cancel_at_period_end`.

### Stale claims in older HANDOFF sections (now corrected)
- "API rate limiting — not implemented" → **false**. `src/lib/security/rate-limit.ts` + table in 0016 + wired in upload/retry/share + (now) status/pdf.
- "Global `app/error.tsx` not present" → **false**. `src/app/global-error.tsx` exists.
- "ESLint flat-config ordering bug" → **fixed**; `eslint.config.mjs:13-26`.
- HANDOFF describes through 0008 — repo has **through 0017**.

---

---

## Latest review-fix pass (2026-05-09): H8 + H9 + H10 done

Stripe webhook hardening landed:

- **H8** — webhook handler errors no longer swallowed. The route now returns
  5xx on handler failure so Stripe retries, and bookkeeps `processed_status`
  on every `billing_events` row. New columns (`processed_at`, `processed_status`,
  `last_error`, `last_attempted_at`) live in `0008_stripe_webhook_hardening.sql`.
- **H9** — `onSubscriptionUpserted` and `onSubscriptionDeleted` now SELECT
  `profiles.subscription_event_at` and refuse updates whose `event.created` is
  older. Also new in 0008: `profiles.subscription_event_at TIMESTAMPTZ`.
- **H10** — handler comments now match the route's actual retry behavior.
- **Recovery cron** — `src/inngest/functions/replay-billing-events.ts` runs
  every 15 min, picks up `processed_status` IS NULL OR 'failed' rows newer
  than 24h that have cooled past 60s since `last_attempted_at`, and re-invokes
  the handler with `previousStatus='failed'` so non-idempotent ops short-circuit.
- **PII** — `last_error` is `scrubString`-redacted and capped at 500 chars.
- **Tests** — 26 new test cases across `tests/stripe/webhook-route-hardening.test.ts`,
  `tests/stripe/handlers.test.ts` (new H9 + credit-replay describe), and
  `tests/inngest/replay-billing-events.test.ts`. Existing webhook + handler
  tests updated to model the new SELECT-then-UPDATE shape.

> ⚠️ **Deploy-order:** apply migration 0008 BEFORE deploying any commit that
> imports the hardened webhook route or the replay cron. Without the new
> columns the route will throw `column does not exist` on every Stripe event
> and the cron will fail every 15 minutes.

## Snapshot (pass this file + `CLAUDE.md` to a fresh session)

A multi-stream review found bugs and gaps; fixes landed across 7 streams. Highlights:

- **Inngest core**: line-index translation between rules and persistence (multi-account audits now correct), idempotency key on `bill.uploaded`, status guards on `mark-extracting`/`mark-failed`, ownership re-check, OCR 12-min timeout, PII redaction in `ExtractionError.details`, sanitized Resend errors.
- **Stripe**: atomic stripe_customer_id race-fix (orphan deletion on loss), row-match assertions on every customer-keyed update (throws on 0 or >1), trialing-status test, real-crypto webhook signature test, payment_failed structured marker, event-type breadcrumb.
- **DB migration 0005**: CHECK constraints (status/carrier/severity/confidence/subscription_status), `findings(rule_id)` index, atomic `refund_orphan_audit` RPC; cleanup function rewired.
- **Rules**: `ExtractedCreditSchema.monthly_cents <= 0` enforced; `account_promo_expiring_soon` narrowed to 31–60d (no overlap); `data_overage_pattern` 50–100GB hole closed; `stale_international_feature` → severity `info`; `orphan_insurance` redundant trigger dropped; registry self-validation; dead `sumLineCharges` removed; cryptic math simplified.
- **UI**: sonner toasts, `/audits` cursor pagination, header credit badge, retry button + `POST /api/audits/[id]/retry`, forgot-password (`/reset-password` + `/auth/update-password`), resend-confirmation with cooldown, killed Phase-3 placeholder, "Queued" stepper label, pre-upload gate banner, draft notice on legal pages.
- **Security**: CSP/HSTS/XFO/Referrer/Permissions-Policy emitted via `next.config.ts` (static headers) and `src/middleware.ts` (CSP). **Production host: Netlify.** `netlify.toml` is the live deploy config; server-only secrets are configured in the Netlify dashboard (production + deploy-preview scopes) and `src/env.ts` rejects placeholder values at startup.
- **Tests**: RLS isolation, share-token edges, PDF cache hit/miss, encrypted PDF, unknown-carrier e2e, concurrent-decrement underflow.

**Status:** typecheck clean, lint clean (`next lint`), 51 test files / 383 passed / 6 todo, `next build` succeeds.

### Where things live

| Topic | Where it lives | Notes |
|--------|----------------|--------|
| CSP **policy string** | `src/middleware.ts` → `buildCsp()` | Applied to **non-API** routes (matcher excludes `/api/*`). Tuning `frame-src` / `script-src` happens here. |
| Other security headers | `next.config.ts` | HSTS, `X-Frame-Options`, `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy. |
| Stripe checkout (promo + tax) | `src/app/api/stripe/checkout/route.ts` | `allow_promotion_codes`, `automatic_tax`, `customer_update` already on `sessions.create`. |
| Past-due payment email | `src/lib/stripe/handlers.ts` → `inngest.send({ name: 'billing.payment_failed', ... })` | Handler: `src/inngest/functions/send-payment-failed-email.ts`. Event schema: `src/inngest/client.ts`. Tests: `tests/stripe/handlers.test.ts`, `tests/inngest/send-payment-failed-email.test.ts`, `tests/email/payment-failed-text.test.ts`. |
| Inbound email (optional) | `src/app/api/inbound/email/route.ts` | Requires `INBOUND_EMAIL_SECRET` (+ domain env). **Differs from SPEC “skip email ingest”** as a product line — code is an opt-in operator path; do not remove without discussion. |
| Outbound webhooks | `src/inngest/functions/dispatch-outbound-webhook.ts`, settings UI | Needs DB columns from **0006** (below). |
| Landing sample screenshot | `src/app/page.tsx` | `SAMPLE_REPORT_IMAGE_AVAILABLE` + `public/report-sample.png` — still **false** until asset exists. |

---

## Recently shipped (do not redo)

Multi-stream hardening already landed, including: Inngest idempotency + line-index translation + guarded status transitions; Stripe webhook row-match assertions + race-safe `stripe_customer_id`; DB **0005** in repo (CHECKs + `refund_orphan_audit` + findings index); rules/registry fixes; UI pagination / retry / forgot-password / toasts; **payment-failed** Inngest + Resend path; **checkout** promo + automatic tax; CSP allowlist in **middleware** (not only `next.config.ts`).

**Static verify:** `pnpm typecheck` clean. `pnpm test` — expect some `it.todo` in gated LLM / encrypted-PDF tests. `pnpm lint` should ignore `.next/**` (see **Lint** below).

---

## Database / operations (blockers for prod parity)

### A. Migration 0005 — deploy-order blocker

> Apply **`supabase/migrations/0005_check_constraints_and_refund_rpc.sql`** to Supabase **before** deploying app code where `cleanup-orphan-audits` calls `refund_orphan_audit`. Otherwise the cron throws `function does not exist` and orphan `pending` audits never clear.

**Pre-apply:** run these against the **live** DB; each `count(*)` must be `0`. Fix data before `ALTER` or the migration can fail mid-flight:

```sql
-- audits.status: only the 5 documented statuses
select count(*) from public.audits
 where status not in ('pending','extracting','analyzing','completed','failed');

-- audits.carrier: nullable + 4 documented values
select count(*) from public.audits
 where carrier is not null
   and carrier not in ('verizon','att','tmobile','unknown');

-- findings.severity: 4 documented values
select count(*) from public.findings
 where severity not in ('high','medium','low','info');

-- findings.confidence: must be in [0, 1]
select count(*) from public.findings
 where confidence < 0 or confidence > 1;

-- profiles.subscription_status: nullable + 8 Stripe statuses
select count(*) from public.profiles
 where subscription_status is not null
   and subscription_status not in (
     'active','trialing','past_due','canceled',
     'incomplete','incomplete_expired','unpaid','paused'
   );
```

Apply via `supabase db push` or Supabase SQL editor. Smoke: run `cleanup-orphan-audits` in Inngest dev — orphaned `pending` → `failed` + credit refunded; second run no-ops.

**Acceptance:** `select pg_get_functiondef('public.refund_orphan_audit'::regproc);` returns a body; new constraints visible in `\d+ public.audits` / `\d+ public.findings` / `\d+ public.profiles`.

### B. Migration 0006 — integrations + inbound

Apply **`supabase/migrations/0006_inbound_outbound.sql`** after 0005 (or whenever you enable integrations):

- Adds `profiles.inbound_email_token`, `outbound_webhook_url`, `outbound_webhook_secret` (+ HTTPS URL check, unique partial index on token).

Without **0006**, `/settings/integrations`, outbound webhook dispatch, and inbound email resolution against `profiles.inbound_email_token` will fail at runtime.

---

## Phase 5 — remaining work (prioritized)

### 1. Landing: real sample report image

- **File:** `src/app/page.tsx` — set `SAMPLE_REPORT_IMAGE_AVAILABLE` to `true` only after `public/report-sample.png` exists.
- **Steps:** Run a real audit on an anonymized fixture (`tests/fixtures/bills/`), capture the web report, save as `public/report-sample.png`, tune `<Image>` dimensions / `alt` / `priority`.
- **Acceptance:** No “coming soon” card when the flag is true; Lighthouse threshold if you use `lhci` + `.lighthouserc.json`.

### 2. Legal pages

- **Files:** `src/app/privacy/page.tsx`, `src/app/terms/page.tsx` — `TODO(launch)` / draft banners until counsel review.
- **Acceptance:** Remove `DraftBanner` when copy is final; update `LAST_UPDATED`.

### 3. CSP — browser smoke (runtime)

No automated CSP tests. Before release, manually hit `/`, auth routes, `/audits`, `/audits/new`, `/audits/[id]`, `/pricing`, Stripe Checkout redirect, `/share/[token]`, toasts, Sentry tunnel — **edit `src/middleware.ts` `buildCsp()`** if a vendor host is blocked (e.g. Stripe iframe domains).

### 3a. CSP hardening (optional)

Nonce-based CSP per [Next.js CSP docs](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy) to drop `'unsafe-inline'` / `'unsafe-eval'` from `script-src` once validated in browser.

### 4. Inngest: cleanup cron visibility

- **File:** `src/inngest/functions/cleanup-orphan-audits.ts` — confirm `cron: '*/15 * * * *'` and export in `src/inngest/functions/index.ts`.
- **Acceptance:** Function appears with schedule in Inngest dashboard after deploy / local `inngest dev`.

### 5. E2E refresh

Run `pnpm test:e2e` with dev server. Selectors may need updates for: `/audits` pagination, header credit badge, failed-audit **Retry**, forgot password link, `/audits/new` gate banner.

### 6. Code markers

```sh
grep -rn "TODO(" src/ supabase/
```

- `TODO(domain)` — Justin-owned; do not invent business logic.
- `TODO(launch)` — Phase 5 polish.
- `TODO(blocker)` — must be zero before merge.

---

## Static gaps (documented; not blockers unless you say so)

- **API rate limiting** — not implemented in-repo; rely on platform/WAF for auth abuse if needed.
- **Vitest** — `tests/extraction/llm.test.ts` has `it.todo` placeholders; `tests/extraction/encrypted-pdf.test.ts` awaits a real encrypted fixture.
- **Lint** — If `pnpm lint` scans `.next/**/*.js`, put global `ignores: ['.next/**', ...]` **first** in `eslint.config.mjs` (flat-config ordering).
- **Global `app/error.tsx`** — not present; Next defaults apply.

---

## Verify before committing

```sh
pnpm typecheck
pnpm lint
pnpm test
SKIP_ENV_VALIDATION=1 pnpm build
```

E2E:

```sh
pnpm test:e2e
```

Gated LLM (costs API credit):

```sh
RUN_LLM_TESTS=1 pnpm test:llm
```

---

## Files not to touch without asking

- `SPEC.md` — frozen canonical spec.
- **`supabase/migrations/0001`–`0004`** — historically applied; only **add** new migrations forward.
- **`0005` / `0006`** — apply to the target Supabase project in order; do not rewrite history on prod.
- `tests/fixtures/bills/*.pdf` — anonymized real bills; do not regenerate without Justin.

---

## Conventions (short)

TypeScript strict + `noUncheckedIndexedAccess`; Zod at boundaries; idempotent Inngest (`step.run`, idempotency keys); no PII in logs. Full list in `CLAUDE.md` / `SPEC.md`.

**Suggested ops order:** apply **0005** → verify RPC/constraints → apply **0006** if using integrations/inbound → deploy app → CSP smoke → E2E.
