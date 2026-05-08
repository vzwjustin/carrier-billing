# CarrierAudit

CarrierAudit is a SaaS that lets a business owner, office manager, MSP, or fractional CFO upload a PDF of their business wireless bill (Verizon, AT&T, or T-Mobile) and receive an audit report identifying wasted spend, wrong rate plans, missing discounts, expired promo credits, and other waste patterns — with estimated monthly savings and recommended actions. Upload a bill, get a professional audit with quantified savings in under five minutes.

## Status

Phases 0–4 shipped. Phase 5 (landing / polish / launch prep) is in progress. See [`CLAUDE.md`](./CLAUDE.md) for the canonical phase plan — that document wins on any conflict.

## What works today

- Email + password auth via Supabase, with middleware-protected `/dashboard` and `/audits` routes.
- Drag-and-drop PDF upload (single file, ≤25 MB) for Verizon Business, AT&T Business, and T-Mobile for Business wireless bills.
- Claude Sonnet 4.6 native-PDF extraction with a strict zod-validated schema; AWS Textract OCR fallback for scanned bills.
- Per-carrier normalization (`src/extraction/carriers/*`) into a single canonical `ExtractedBill`.
- 10 starter audit rules under `src/rules/definitions/`. Per-rule errors are caught and surfaced to Sentry without failing the audit.
- Web report viewer with savings hero, severity-grouped findings, and bill summary panels.
- Public `/share/<token>` read-only links plus downloadable PDF reports (cached in private Supabase Storage).
- Stripe billing: $149 one-time audit credits and $99/mo unlimited subscription, with idempotent webhook handling and atomic credit decrement on `pending → extracting`.
- Inngest worker pipeline: every step in `process-bill` is idempotent on retry; dedicated `send-report-email` function delivers via Resend.
- Sentry + PostHog wired (both no-op without DSN/key set so local dev stays quiet).

## Tech stack

Quick summary — see [`CLAUDE.md` §2](./CLAUDE.md) for the locked choices and rationale.

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router) + TypeScript (strict, `noUncheckedIndexedAccess`) |
| Styling | Tailwind CSS v4 + shadcn/ui |
| DB / Auth / Storage | Supabase (Postgres + Auth + Storage) |
| Background jobs | Inngest |
| Payments | Stripe Checkout + Customer Portal + Webhooks |
| LLM | Anthropic Claude Sonnet 4.6 (`claude-sonnet-4-6`) with native PDF input |
| OCR fallback | AWS Textract |
| PDF text | `pdf-parse` + `pdfjs-dist` |
| Report PDF | `@react-pdf/renderer` |
| Forms / Validation | `react-hook-form` + `zod` |
| Email | Resend |
| Testing | Vitest + Playwright |
| Hosting | Vercel |
| Analytics / Errors | PostHog + Sentry |

## Prerequisites

- **Node.js 22** (`nvm use 22` or similar).
- **pnpm 10.33.0+** (`corepack enable && corepack prepare pnpm@10.33.0 --activate`).
- Accounts:
  - [Supabase](https://supabase.com) — Postgres, auth, storage.
  - [Stripe](https://stripe.com) — payments (test mode is fine for local dev).
  - [Anthropic](https://console.anthropic.com) — Claude API key.
  - [AWS](https://aws.amazon.com) — Textract (IAM user with `AmazonTextractFullAccess`).
  - [Resend](https://resend.com) — transactional email.
  - [Inngest](https://www.inngest.com) — background jobs (free tier is plenty).
  - Optional: [Sentry](https://sentry.io) + [PostHog](https://posthog.com) for observability.

## Local setup

1. **Clone and install**

   ```bash
   git clone <repo-url> carrieraudit
   cd carrieraudit
   pnpm install
   ```

2. **Environment variables**

   Copy [`.env.example`](./.env.example) to `.env.local` and fill in every required value. The app fails to boot if any required var is missing (validated in [`src/env.ts`](./src/env.ts) via `@t3-oss/env-nextjs`). Set `SKIP_ENV_VALIDATION=1` only for build-time CI checks where secrets aren't available.

   ```bash
   cp .env.example .env.local
   ```

3. **Supabase**

   - Create a new Supabase project.
   - Run all migrations in order via the SQL editor or the Supabase CLI (`supabase db push`):
     - `supabase/migrations/0001_init.sql` — profiles, audits, bill_*, findings, billing_events.
     - `supabase/migrations/0002_storage.sql` — `bills` private bucket + signed-upload policy.
     - `supabase/migrations/0003_reports_storage.sql` — `reports` private bucket for cached PDFs.
     - `supabase/migrations/0004_billing_helpers.sql` — `increment_audit_credits` RPC.
   - If a bucket isn't auto-created by the migration, create `bills` and `reports` as private buckets in **Storage → New bucket**.
   - Copy `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from **Settings → API** into `.env.local`.

4. **Stripe**

   - In test mode, create two products with prices:
     - **One-time audit** — $149 (one-time). Copy the price ID into `STRIPE_PRICE_ID_ONE_TIME`.
     - **Subscription** — $99/month (recurring). Copy the price ID into `STRIPE_PRICE_ID_SUBSCRIPTION`.
   - Copy your secret + publishable keys into `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
   - For local webhook testing in another terminal:

     ```bash
     stripe listen --forward-to localhost:3000/api/stripe/webhook
     ```

     Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`.

5. **Inngest**

   In another terminal, start the Inngest dev server — it auto-discovers the serve handler at `/api/inngest`:

   ```bash
   pnpm dlx inngest-cli@latest dev
   ```

   The Inngest dev UI runs at <http://localhost:8288>.

6. **Resend**

   Confirm a sender domain in the Resend dashboard. (TODO: use `reports@carrieraudit.com` once the domain is set up.) Copy `RESEND_API_KEY` into `.env.local`.

7. **Run the app**

   ```bash
   pnpm dev
   ```

   Open <http://localhost:3000>.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Start the Next.js dev server. |
| `pnpm build` | Production build. |
| `pnpm start` | Run the production build. |
| `pnpm lint` | ESLint over the whole repo. |
| `pnpm typecheck` | `tsc --noEmit` (strict). |
| `pnpm test` | Vitest unit + integration tests (excludes `tests/e2e` and `tests/fixtures`). |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm test:llm` | Run the gated LLM-extraction fixtures (burns API credit; `RUN_LLM_TESTS=1`). |
| `pnpm test:e2e` | Playwright end-to-end tests. |
| `pnpm format` | Prettier write across the repo. |
| `pnpm format:check` | Prettier check (no write). |

## Project layout

See [`CLAUDE.md` §3](./CLAUDE.md) for the full tree. High-level:

- `src/app/` — Next.js App Router (marketing, auth, app, API).
- `src/extraction/` — PDF + LLM bill extraction pipeline.
- `src/rules/` — rules engine (registry + per-rule definitions).
- `src/reports/` — web + `@react-pdf/renderer` report rendering.
- `src/inngest/` — durable background jobs.
- `src/lib/access/` — credit/subscription gating used by `/api/audits`.
- `src/lib/analytics/` — typed PostHog event helpers (Phase 5).
- `src/lib/{supabase,stripe,resend,posthog}/` — third-party clients.
- `supabase/migrations/` — SQL migrations.
- `tests/` — Vitest unit + integration suites; `tests/fixtures/bills/` for anonymized PDF/JSON pairs; `tests/e2e/` for Playwright.

## Phase 0 acceptance — DONE

- [x] `pnpm dev` runs cleanly with no missing env errors.
- [x] Sign up + log in works against Supabase auth.
- [x] Empty `(app)/dashboard` page loads behind auth (middleware redirects unauthenticated users to `/login`).
- [x] Stripe webhook endpoint at `/api/stripe/webhook` returns 200 on a verified test event and persists to `billing_events`.
- [x] Inngest dashboard shows the scaffolded hello function.
- [x] Sentry captures a test error (server + client).
- [x] PostHog records a test event from the client (no-op without key).
- [x] CI passes on PR (lint, typecheck, vitest, build).
- [x] Vercel project connected: `main` → prod, PRs → preview.

## Phase 1 acceptance — DONE

- [x] Drag-and-drop upload at `/audits/new`; presigned upload URL via `/api/audits` → PUT to Supabase Storage `bills` bucket → `POST /api/audits/[id]/start` triggers Inngest `bill.uploaded`.
- [x] `process-bill` Inngest function downloads the PDF, runs extraction, persists `bill_accounts` / `bill_lines` / `bill_features` / `bill_credits` / `bill_dpp_installments`, and moves status `pending → extracting → analyzing`.
- [x] Carrier detection via header heuristics with Verizon / AT&T / T-Mobile / unknown verdicts.
- [x] Claude extraction with strict zod schema validation; one retry-on-validation-failure pass before failing.
- [x] Textract OCR fallback when `pdf-parse` returns < 500 chars of text.
- [x] Anonymization script `scripts/anonymize-bill.ts` plus committed anonymized fixtures under `tests/fixtures/bills/`.
- [x] Audit detail page at `/audits/[id]` polls `/api/audits/[id]/status` and shows the live stepper.
- [x] Failure path: corrupt or non-wireless PDFs land the audit in `failed` with a user-readable `failure_reason`.

## Phase 2 acceptance — DONE

- [x] Rule infrastructure: `src/rules/{types,registry,runner,helpers}.ts` plus one file per rule under `definitions/`.
- [x] `process-bill` runs rules after extraction, persists `findings`, and flips status to `completed` with aggregate `finding_count`, `high_severity_count`, and `estimated_{monthly,annual}_savings_cents`.
- [x] All 10 starter rules implemented with structurally-correct logic and `TODO(domain)` markers where Justin's expertise will refine thresholds:
  - `expired_promo_credit`, `completed_device_payment_still_billed`, `orphan_insurance`, `stale_international_feature`, `unused_mifi_or_jetpack_line`, `suspended_line_billed`, `legacy_unlimited_plan`, `data_overage_pattern`, `duplicate_protection_features`, `account_level_promo_about_to_expire`.
- [x] Per-rule errors are caught by `runner.ts` and surfaced to Sentry without failing the audit.
- [x] `/api/audits/[id]/status` returns `{ status, progress, currentStep }`.
- [x] Unit tests per rule (positive + negative fixtures) plus a `runner` snapshot test against a full bill.

## Phase 3 acceptance — DONE

- [x] Web report at `/audits/[id]`: hero with monthly + annual savings, severity-grouped findings with descriptions / recommendations / confidence / affected lines, bill summary panels.
- [x] PDF report via `@react-pdf/renderer`: cover, executive summary, findings pages, methodology + disclaimer. Generated server-side, cached at `reports/{auditId}.pdf` in private Storage.
- [x] Public read-only viewer at `/share/[token]` (no auth required) using the same React components with sharing UI hidden.
- [x] Resend `audit-completed` email triggered after `mark-completed` via the `audit.completed` Inngest event and `send-report-email` function.

## Phase 4 acceptance — DONE

- [x] `/pricing` shows the two plan cards and routes to Stripe Checkout via `/api/stripe/checkout`.
- [x] `/api/stripe/webhook` verifies signatures, dedupes via `billing_events.stripe_event_id`, and handles `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`, and `invoice.payment_failed`.
- [x] One-time purchase increments `profiles.audit_credits` atomically through the `increment_audit_credits` RPC.
- [x] Subscription state stored on `profiles.subscription_status` + `subscription_id`.
- [x] Access control gate (`src/lib/access/`) enforced on `/api/audits`: must have `audit_credits > 0` OR `subscription_status === 'active'`. One-time credits decrement when the audit moves out of `pending`.
- [x] `/settings/billing` redirects to the Stripe Customer Portal.
- [x] Webhook idempotency + access-control unit tests in `tests/stripe/` and `tests/access/`.

## Phase 5 status — IN PROGRESS

- [x] Marketing landing page at `/` with hero, "how it works", "what we find", sample report preview, pricing teaser, FAQ.
- [x] Empty states on `/dashboard` and `/audits`.
- [x] Loading skeletons in `src/components/audits/audit-viewer.tsx` while the audit is in flight.
- [x] `GET /api/health` returning `{ status, checks: { db, stripe, anthropic } }`.
- [x] Typed PostHog event helpers in `src/lib/analytics/events.ts` wired into upload, audit completion, report viewing, PDF download, share generation, and Stripe checkout flows.
- [x] README rewritten to reflect Phases 0–4 (this file).
- [x] Playwright E2E specs for the public auth-free surface and `/api/health`.
- [ ] Privacy + Terms placeholder pages.
- [ ] Sentry sourcemap upload in production CI.
- [ ] Lighthouse score ≥ 90 verification on the landing page.

## Deploy

CarrierAudit is built to deploy on **Vercel**.

1. Connect the GitHub repo to a new Vercel project.
2. Add every variable from `.env.example` to the Vercel project's environment (Production + Preview). For preview deploys against test infra, use Stripe test keys and a separate Supabase project.
3. Push `main` → production deploy. Open a PR → preview deploy.
4. **After the first deploy:**
   - Update the Stripe webhook endpoint to `https://<your-domain>/api/stripe/webhook` and copy the new signing secret into Vercel env (`STRIPE_WEBHOOK_SECRET`).
   - Set the Inngest production app URL to `https://<your-domain>/api/inngest` and copy `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` from the Inngest dashboard.
   - Update Supabase **Auth → URL Configuration** to include the deployed origin.
   - Configure the Resend sender domain DNS records.

## Testing

- **Unit + integration:** `pnpm test` runs the full Vitest suite (≈149 tests at the time of writing) excluding `tests/e2e` and `tests/fixtures`. CI runs this on every PR.
- **LLM extraction (gated):** `pnpm test:llm` runs the Claude extraction call against bill fixtures. Costs API credit; not in CI by default. Run locally before shipping schema or prompt changes.
- **End-to-end:** `pnpm test:e2e` runs the Playwright happy-path tests. The config boots `pnpm dev` automatically; expect the first run to take a minute. Sandboxed Supabase + Stripe environments are required for a full signup → buy → upload → report flow; the committed specs cover the auth-free public surface and `/api/health`.

Per [`CLAUDE.md` §9](./CLAUDE.md), the rules engine is the product — every rule needs positive + negative unit tests with realistic fixture data. The extraction pipeline gets schema-validation + golden-snapshot tests against anonymized fixtures under `tests/fixtures/bills/`.

## Security + privacy

- **PII discipline (CLAUDE.md §1#9).** Logs only contain audit IDs, user IDs, rule IDs, and aggregate counts. Raw bill content, employee names, full phone numbers, and full account numbers never leave the database — we mask to last-four for both account numbers and MDNs at extraction time.
- **RLS enforced ownership.** Every user-scoped table has Row Level Security; the service-role admin client is only used inside `src/lib/supabase/admin.ts` from Inngest workers and webhook handlers.
- **Share tokens.** Generated as 24 random bytes (base64url) via `node:crypto.randomBytes`; opt-in (only when the user clicks "Share"); resolvable to a single completed audit via the `share_token` column.
- **Storage.** `bills` and `reports` buckets are private. The PDF report endpoint always serves bytes through Next, never via direct storage URLs.

## Phase plan

Build proceeds in the phases defined in [`CLAUDE.md` §6](./CLAUDE.md):

0. Project setup ✅
1. PDF upload + extraction pipeline ✅
2. Rules engine + first 10 rules ✅
3. Report viewer + PDF export ✅
4. Billing & access control ✅
5. Landing page, polish, launch prep — IN PROGRESS

Each phase ends with a `STOP` checkpoint for human review.

---

See [`CLAUDE.md`](./CLAUDE.md) for the canonical spec — that document wins on any conflict.
