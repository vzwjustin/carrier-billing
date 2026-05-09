# CarrierAudit — Handoff for next Claude session

> **You are picking up work on a Next.js 15 SaaS** (`CarrierAudit`) that audits business wireless bills.
> The canonical product spec is [`SPEC.md`](./SPEC.md). The README is [`README.md`](./README.md). This file is a **work-tonight TODO** — everything below is a real, scoped task with file paths.
>
> Phases 0–4 of the build plan are shipped. Phase 5 (launch prep) is partially done as of the last commit on this branch.

---

## What was just done (so you don't redo it)

A multi-stream review found bugs and gaps; fixes landed across 7 streams. Highlights:

- **Inngest core**: line-index translation between rules and persistence (multi-account audits now correct), idempotency key on `bill.uploaded`, status guards on `mark-extracting`/`mark-failed`, ownership re-check, OCR 12-min timeout, PII redaction in `ExtractionError.details`, sanitized Resend errors.
- **Stripe**: atomic stripe_customer_id race-fix (orphan deletion on loss), row-match assertions on every customer-keyed update (throws on 0 or >1), trialing-status test, real-crypto webhook signature test, payment_failed structured marker, event-type breadcrumb.
- **DB migration 0005**: CHECK constraints (status/carrier/severity/confidence/subscription_status), `findings(rule_id)` index, atomic `refund_orphan_audit` RPC; cleanup function rewired.
- **Rules**: `ExtractedCreditSchema.monthly_cents <= 0` enforced; `account_promo_expiring_soon` narrowed to 31–60d (no overlap); `data_overage_pattern` 50–100GB hole closed; `stale_international_feature` → severity `info`; `orphan_insurance` redundant trigger dropped; registry self-validation; dead `sumLineCharges` removed; cryptic math simplified.
- **UI**: sonner toasts, `/audits` cursor pagination, header credit badge, retry button + `POST /api/audits/[id]/retry`, forgot-password (`/reset-password` + `/auth/update-password`), resend-confirmation with cooldown, killed Phase-3 placeholder, "Queued" stepper label, pre-upload gate banner, draft notice on legal pages.
- **Security**: CSP/HSTS/XFO/Referrer/Permissions-Policy in `next.config.ts`. `netlify.toml` removed (Vercel only).
- **Tests**: RLS isolation, share-token edges, PDF cache hit/miss, encrypted PDF, unknown-carrier e2e, concurrent-decrement underflow.

**Status:** typecheck clean, lint clean (`next lint`), 51 test files / 383 passed / 6 todo, `next build` succeeds.

---

## What's left — work this tonight

Tasks are independent unless noted. Each has acceptance criteria. Mark a TaskCreate at the start; verify with the noted commands.

### 1. Apply migration 0005 to Supabase — DEPLOY-ORDER BLOCKER

> ⚠️ **Critical deploy-order rule:** apply migration 0005 to Supabase **BEFORE** deploying any commit that contains the rewired `cleanup-orphan-audits` function. That function now calls `supabase.rpc('refund_orphan_audit', ...)`. If the cron fires before the RPC exists, every cleanup invocation will throw `function does not exist`, the orphan audits will sit `pending` forever (and the cron will keep retrying and failing) until the migration lands.
>
> **Safe sequence:** apply 0005 → verify (acceptance check below) → only then deploy `main`.

The new RPC and CHECK constraints aren't live until applied.

- File: `supabase/migrations/0005_check_constraints_and_refund_rpc.sql`
- **Pre-apply: run these SELECTs against the live DB to confirm no row will trip the new CHECKs.** Each must return `0`. If any returns `>0`, FIX THE DATA before applying, otherwise the `ALTER TABLE` will fail mid-migration and leave the schema half-done:

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
  -- (covers: 'active','trialing','past_due','canceled','incomplete',
  --  'incomplete_expired','unpaid','paused')
  select count(*) from public.profiles
   where subscription_status is not null
     and subscription_status not in (
       'active','trialing','past_due','canceled',
       'incomplete','incomplete_expired','unpaid','paused'
     );
  ```
- Steps:
  1. Run all 5 SELECTs above. Each must return 0. Fix data first if not.
  2. Apply via `supabase db push` or paste the migration into the Supabase SQL editor.
  3. Smoke test: trigger `cleanup-orphan-audits` via Inngest dev UI; confirm an orphaned `pending` audit gets `status='failed'` and the credit is refunded atomically (single transactional unit; verify by re-running and seeing it no-op the second time).
- **Acceptance:** `select pg_get_functiondef('public.refund_orphan_audit'::regproc);` returns the function definition; the 5 new constraints are visible in `\d+ public.audits` / `\d+ public.findings` / `\d+ public.profiles`.

### 2. Wire payment_failed email (Stream B left a marker)

`src/lib/stripe/handlers.ts:onInvoicePaymentFailed` currently emits a structured log line but no email. Hook up Resend.

- Add `src/lib/email/payment-failed.tsx` (mirror `audit-completed.tsx` shape) + `payment-failed-text.ts`.
- Add `src/inngest/functions/send-payment-failed-email.ts` triggered by `audit.subscription_payment_failed`.
- Have `onInvoicePaymentFailed` send that Inngest event after the past_due update (it already has `userId` and `customerEmail` available).
- Tests: `tests/email/payment-failed-text.test.ts` and `tests/inngest/send-payment-failed-email.test.ts` (mirror existing patterns).
- **Acceptance:** `pnpm test` still green; new function registered in `src/inngest/functions/index.ts`.

### 3. Replace landing-page placeholder (`src/app/page.tsx`)

There's a "Sample report — coming soon" placeholder card (search for `TODO(launch): replace with real anonymized report screenshot`).

- Pick one of the anonymized fixtures under `tests/fixtures/bills/` (e.g., `verizon-business-medium.pdf`), run a real audit locally, screenshot the rendered web report, store under `public/report-sample.png` (Next.js statics).
- Replace the placeholder card with a `<Image>` of that screenshot, with proper `width`/`height`/`alt` and `priority` (above-the-fold).
- **Acceptance:** Lighthouse on landing page still ≥90 (`./node_modules/.bin/next start` then run `.lighthouserc.json` thresholds via `lhci`).

### 4. Replace legal "DRAFT" notice when reviewed (or remove entirely)

`src/app/privacy/page.tsx` and `src/app/terms/page.tsx` ship with a "DRAFT" banner — placeholder until counsel reviews.

- If you have reviewed text, replace the body content and remove the `DraftBanner` component.
- Update `LAST_UPDATED` constants.
- **Acceptance:** banner gone from both pages; pages render at `/privacy` and `/terms`.

### 5. Smoke-test the new CSP (recommended before next deploy)

The CSP shipped in `next.config.ts` is restrictive — it carves out the vendor hosts that the app needs (Stripe, Supabase, PostHog, Sentry) but the **only way to verify it doesn't break anything is at runtime**. There is no automated test for CSP violations.

- Run `pnpm dev` (or `next start` after `next build`) and open the browser devtools console.
- Visit, in order: `/`, `/login`, `/signup`, `/reset-password`, `/dashboard`, `/audits`, `/audits/new`, an actual `/audits/<id>` (in any state), `/pricing`, `/settings/billing` (which redirects to Stripe portal — verify no console errors during redirect), and a `/share/<token>` link.
- Trigger a sonner toast (e.g. share a report → click "Copy link") and confirm it renders without CSP violations.
- Click through to Stripe Checkout from `/pricing`; verify the redirect lands cleanly. If Stripe Checkout iframes anything from `m.stripe.network`, you'll see a `frame-src` violation — relax that directive in `next.config.ts` if so.
- Trigger a Sentry test error (browser console: `throw new Error('csp-test')`) and verify the error reaches Sentry's tunneled `/monitoring` endpoint.
- **Acceptance:** zero CSP violations across the routes above.

### 5a. Tighten CSP further (optional)

`script-src 'self' 'unsafe-inline' 'unsafe-eval'` is needed for Next 15's inline boot scripts. To eliminate `'unsafe-inline'`/`'unsafe-eval'`, switch to nonce-based CSP via Next.js middleware:

- See https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
- **Acceptance:** browser console shows zero violations on the same surfaces; CSP `script-src` no longer needs the unsafe-* directives.

### 6. Tune Stripe checkout: allow promo codes + tax collection

Out of scope of the original review but standard Phase 5 polish.

- `src/app/api/stripe/checkout/route.ts`: add `allow_promotion_codes: true`, `automatic_tax: { enabled: true }`, `customer_update: { address: 'auto' }` to the `sessions.create` call.
- **Acceptance:** test checkout in Stripe test mode shows promo-code input field.

### 7. Confirm Inngest cron for cleanup-orphan-audits is registered

`src/inngest/functions/cleanup-orphan-audits.ts` should be on a `cron: '*/15 * * * *'` schedule. Verify it's in `src/inngest/functions/index.ts` exports and shows in the Inngest dashboard once deployed.

- **Acceptance:** Inngest dashboard shows the function with a cron trigger after `pnpm dlx inngest-cli@latest dev` is run locally.

### 8. E2E suite refresh

Run `pnpm test:e2e` against a dev server. Expect updates needed because:

- `/audits` now has pagination controls (Next button)
- The header has a credit/sub badge near the user email
- Failed-audit page now has a "Retry" button
- Login page has "Forgot password?" link
- Audits/new shows a gate banner above the dropzone

Update `tests/e2e/happy-path.spec.ts` and `tests/e2e/landing.spec.ts` if any selector broke.

- **Acceptance:** `pnpm test:e2e` green locally.

### 9. Open follow-ups in code (search for `TODO(`)

Run:
```
grep -rn "TODO(" src/ supabase/
```

You'll find:
- `TODO(domain)` — Justin will fill in domain logic (don't touch).
- `TODO(launch)` — pre-launch tasks. Tackle these.
- Any `TODO(blocker)` — there shouldn't be any; if found, fix immediately.

---

## How to verify before committing

```sh
./node_modules/.bin/tsc --noEmit          # typecheck
./node_modules/.bin/next lint             # lint (the actual repo command)
./node_modules/.bin/vitest run            # unit + integration
SKIP_ENV_VALIDATION=1 ./node_modules/.bin/next build   # prod build
```

E2E:
```sh
./node_modules/.bin/playwright test
```

LLM-extraction tests (gated, burns API credit — only run intentionally):
```sh
RUN_LLM_TESTS=1 ./node_modules/.bin/vitest run tests/extraction/llm.test.ts
```

---

## Files not to touch without asking

- `SPEC.md` — canonical spec, frozen.
- `supabase/migrations/0001_init.sql` through `0004_billing_helpers.sql` — already applied to prod; only add new migrations.
- `tests/fixtures/bills/*.pdf` — anonymized real bills; don't regenerate without consulting Justin.

---

## Coding conventions (cribbed from SPEC.md operating principles)

- TypeScript strict (`noUncheckedIndexedAccess`); no `any`.
- Zod everywhere there's a boundary (API routes, Inngest functions, LLM outputs, env vars, form inputs).
- No `any`. No premature abstraction. Three call sites before extracting a util.
- Idempotent Inngest jobs — every side effect inside `step.run`.
- Don't log PII (phone numbers, employee names, account numbers).
- Test the rules engine seriously; report side can lean on snapshots.

Good luck. Start with **Task 1 (apply migration 0005)** because subsequent code assumes it's live.
