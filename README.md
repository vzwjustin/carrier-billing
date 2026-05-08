# CarrierAudit

CarrierAudit is a SaaS that lets a business owner, office manager, MSP, or fractional CFO upload a PDF of their business wireless bill (Verizon, AT&T, or T-Mobile) and receive an audit report identifying wasted spend, wrong rate plans, missing discounts, expired promo credits, and other waste patterns — with estimated monthly savings and recommended actions. Upload a bill, get a professional audit with quantified savings in under 5 minutes.

## Status

Phase 0 (project setup). See [`CLAUDE.md`](./CLAUDE.md) for the full phase plan and canonical specification — that document wins on any conflict.

## Tech stack

Quick summary, see [`CLAUDE.md` §2](./CLAUDE.md) for the locked choices and rationale.

- **Framework:** Next.js 15 (App Router) + TypeScript (strict)
- **Styling:** Tailwind CSS v4 + shadcn/ui
- **DB / Auth / Storage:** Supabase (Postgres + Auth + Storage)
- **Background jobs:** Inngest
- **Payments:** Stripe Checkout + Customer Portal + Webhooks
- **LLM:** Anthropic Claude Sonnet 4.6 (`claude-sonnet-4-6`) with native PDF input
- **OCR fallback:** AWS Textract
- **PDF text:** `pdf-parse` + `pdfjs-dist`
- **Report PDF:** `@react-pdf/renderer`
- **Forms / Validation:** `react-hook-form` + `zod`
- **Email:** Resend
- **Testing:** Vitest + Playwright
- **Hosting:** Vercel
- **Analytics / Errors:** PostHog + Sentry

## Prerequisites

- **Node.js 22** (use `nvm use 22` or similar)
- **pnpm 10** (`corepack enable && corepack prepare pnpm@10 --activate`)
- Accounts:
  - [Supabase](https://supabase.com) — Postgres, auth, storage
  - [Stripe](https://stripe.com) — payments (test mode is fine for local dev)
  - [Anthropic](https://console.anthropic.com) — Claude API key
  - [AWS](https://aws.amazon.com) — Textract (IAM user with `AmazonTextractFullAccess`)
  - [Resend](https://resend.com) — transactional email
  - [Inngest](https://www.inngest.com) — background jobs (free tier)
  - Optional: [Sentry](https://sentry.io) and [PostHog](https://posthog.com) — observability

## Local setup

1. **Clone and install**

   ```bash
   git clone <repo-url> carrieraudit
   cd carrieraudit
   pnpm install
   ```

2. **Environment variables**

   Copy [`.env.example`](./.env.example) to `.env.local` and fill in every required value:

   ```bash
   cp .env.example .env.local
   ```

   The app fails to boot if any required var is missing (validated in `src/env.ts`). Set `SKIP_ENV_VALIDATION=1` only for build-time CI checks where secrets aren't available.

3. **Supabase**

   - Create a new Supabase project.
   - Run the initial migration in `supabase/migrations/0001_init.sql` via the SQL editor, or with the CLI: `supabase db push`.
   - In the Supabase dashboard: **Storage → New bucket → name `bills`, private**.
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

     Copy the printed webhook signing secret into `STRIPE_WEBHOOK_SECRET`.

5. **Inngest**

   In another terminal, run the Inngest dev server — it auto-discovers the serve handler at `/api/inngest`:

   ```bash
   pnpm dlx inngest-cli@latest dev
   ```

   The Inngest dev UI runs at <http://localhost:8288>.

6. **Run the app**

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
| `pnpm test` | Vitest unit + integration tests (excludes `tests/e2e`). |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm test:llm` | Run gated LLM-extraction fixtures (burns API credit). |
| `pnpm test:e2e` | Playwright end-to-end tests. |
| `pnpm format` | Prettier write across the repo. |

## Project layout

See [`CLAUDE.md` §3](./CLAUDE.md) for the full tree. High-level:

- `src/app/` — Next.js App Router (marketing, auth, app, API)
- `src/extraction/` — PDF + LLM bill extraction pipeline
- `src/rules/` — rules engine (registry + per-rule definitions)
- `src/reports/` — web + PDF report rendering
- `src/inngest/` — durable background jobs
- `src/lib/` — third-party clients (Supabase, Stripe, Anthropic, etc.)
- `supabase/migrations/` — SQL migrations
- `tests/` — Vitest + Playwright + bill fixtures

## Phase 0 acceptance checklist

Mirrors [`CLAUDE.md` §6 Phase 0](./CLAUDE.md):

- [ ] `pnpm dev` runs cleanly with no missing env errors.
- [ ] Sign up + log in works against Supabase auth.
- [ ] An empty `(app)/dashboard` page loads behind auth (middleware redirects unauthenticated users to `/login`).
- [ ] Stripe webhook endpoint at `/api/stripe/webhook` returns `200` on a verified test event and persists to `billing_events`.
- [ ] Inngest dashboard shows the scaffolded hello function.
- [ ] Sentry captures a test error (server + client).
- [ ] PostHog records a test event from the client.
- [ ] CI passes on PR (lint, typecheck, vitest, build).
- [ ] Vercel project connected: `main` → prod, PRs → preview.

## Deploy

CarrierAudit is built to deploy on **Vercel**.

1. Connect the GitHub repo to a new Vercel project.
2. Add every variable from `.env.example` to the Vercel project's environment (Production + Preview). For preview deploys against test infra, use Stripe test keys and a separate Supabase project.
3. Push `main` → production deploy. Open a PR → preview deploy.
4. **After the first deploy:**
   - Update the Stripe webhook endpoint to `https://<your-domain>/api/stripe/webhook` and copy the new signing secret into Vercel env.
   - Set the Inngest production app URL to `https://<your-domain>/api/inngest` and copy `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` from the Inngest dashboard.
   - Update Supabase **Auth → URL Configuration** to include the deployed origin.

## Testing

- **Unit + integration:** `pnpm test` — runs all `tests/**/*.test.{ts,tsx}` except `tests/e2e` and `tests/fixtures`. CI runs this on every PR.
- **LLM extraction (gated):** `pnpm test:llm` — runs the Claude extraction call against bill fixtures. Costs API credit; not in CI by default. Run locally before shipping schema or prompt changes.
- **End-to-end:** `pnpm test:e2e` — Playwright happy-path test. The config boots `pnpm dev` automatically; expect first run to take a minute.

Per [`CLAUDE.md` §9](./CLAUDE.md), the rules engine is the product — every rule needs positive + negative unit tests with realistic fixture data. The extraction pipeline gets schema-validation + golden-snapshot tests against anonymized fixtures under `tests/fixtures/bills/`.

## Phase plan

Build proceeds in the phases defined in [`CLAUDE.md` §6](./CLAUDE.md):

0. Project setup (this phase)
1. PDF upload + extraction pipeline
2. Rules engine + first 10 rules
3. Report viewer + PDF export
4. Billing & access control
5. Landing page, polish, launch prep

Each phase ends with a `STOP` checkpoint for human review.

---

See [`CLAUDE.md`](./CLAUDE.md) for the canonical spec — that document wins on any conflict.
