# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Pointers

- **Product spec (canonical, frozen):** [`SPEC.md`](./SPEC.md). The full build brief — phase plan, data model, extraction prompt, rule pattern, failure modes. On any conflict between this file and SPEC.md, SPEC.md wins.
- **Operator-facing setup:** [`README.md`](./README.md).
- **Pending work for the next session:** [`HANDOFF.md`](./HANDOFF.md). If you're picking up unfinished work, start there.

Phases 0–4 of SPEC.md are shipped. Phase 5 (launch polish) is partially landed — see HANDOFF.md.

## Common Commands

This repo uses **pnpm 10.33.0** and **Node 22+**. All commands run from `carrier-billing/`.

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Dev server | `pnpm dev` (Next.js) |
| Production build | `pnpm build` (set `SKIP_ENV_VALIDATION=1` if env not populated) |
| Run prod build | `pnpm start` |
| Typecheck | `pnpm typecheck` (tsc --noEmit, strict + `noUncheckedIndexedAccess`) |
| Lint | `pnpm lint` (`next lint`) |
| Format | `pnpm format` / `pnpm format:check` |
| Unit + integration tests | `pnpm test` (Vitest) |
| Watch mode | `pnpm test:watch` |
| Single test file | `pnpm test -- tests/rules/expired-promo-credit.test.ts` |
| Single test by name | `pnpm test -- -t "fires on expired credit"` |
| Gated LLM tests (real Claude API, costs credit) | `RUN_LLM_TESTS=1 pnpm test:llm` |
| E2E | `pnpm test:e2e` (Playwright; needs dev server unless `RUN_FULL_E2E=1`) |
| Single E2E spec | `pnpm test:e2e tests/e2e/happy-path.spec.ts` |
| Regenerate fixtures | `pnpm fixtures:generate` |
| Provision Stripe + Supabase | `pnpm bootstrap` (idempotent; supports `--dry-run`) |
| Anonymize a real bill for fixtures | `pnpm dlx tsx scripts/anonymize-bill.ts <input.pdf> <output.pdf>` |

For local dev, also run the Inngest dev server in a second terminal:
```sh
pnpm dlx inngest-cli@latest dev
```
Stripe webhook forwarding (third terminal):
```sh
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

## Architecture — Big Picture

CarrierAudit ingests a PDF wireless bill, extracts structured data with Claude Sonnet, runs a rules engine, and produces a savings report. The flow is intentionally split across an HTTP request and an Inngest worker so the LLM/OCR/rules pipeline runs durably.

### Request → Worker handoff

1. **Upload init** (`POST /api/audits` in `src/app/api/audits/route.ts`) — runs the access gate (`src/lib/access/gate.ts`), atomically decrements credits via the `increment_audit_credits` RPC (`src/lib/access/decrement.ts`), inserts the `audits` row in `pending`, and returns a Supabase signed-upload URL.
2. **Upload + start** — client PUTs the PDF to Supabase Storage `bills` bucket, then `POST /api/audits/[id]/start` fires `bill.uploaded` Inngest event with idempotency key `${auditId}-uploaded`.
3. **Worker** (`src/inngest/functions/process-bill.ts`) — durable, retry-safe pipeline. Steps in order: `mark-extracting` (status guard) → `fetch-pdf` → `extract` (12-min `withTimeout`; runs `runExtractionPipeline`) → `persist-bill` → `run-rules` → `translate-line-indexes` → `persist-findings` → `mark-completed` → fires `audit.completed`.
4. **Email** (`src/inngest/functions/send-report-email.ts`) — handles `audit.completed`; renders + caches PDF at `reports/{auditId}.pdf`; sends via Resend.

Every side effect inside `process-bill` is in `step.run` so it survives retries. Status transitions are guarded (`.eq('status','pending')` style) so concurrent runs can't double-write.

### Extraction pipeline (`src/extraction/`)

`runExtractionPipeline` orchestrates: `pdf.ts` (pdf-parse text + page count) → `detect.ts` (carrier from header heuristics) → `ocr.ts` (Textract sync ≤5MB / async via S3 >5MB, only when text < threshold) → `llm.ts` (Claude Sonnet with native PDF input + retry-on-validation-failure) → carrier-specific normalizer (`carriers/{verizon,att,tmobile}.ts`) → `ExtractedBillSchema.parse` (`schema.ts`).

The schema is the contract between the LLM and the rest of the system. Treat it like an API. Money is signed integer cents; credits are constrained to `<= 0`; phone/account fields are last-4 only.

### Rules engine (`src/rules/`)

10 rules under `definitions/`, registered in `registry.ts` (which self-validates uniqueness + carrier filters at module load). `runner.ts` runs each rule in isolation — a thrown rule doesn't break the audit, it logs to Sentry and continues. Rules emit findings with **per-account-scoped** `affected_line_indexes`; `process-bill.ts:translateLineIndexes` converts them to global flat indexes before persistence (a bug found and fixed in the multi-stream review — see commit `fdcd9a2`).

Each rule has positive + negative unit tests in `tests/rules/`. The runner has a snapshot test against a multi-rule fixture.

### Reports (`src/reports/`, `src/components/report/`)

The same React components render web (`src/app/(app)/audits/[id]`, `src/app/share/[token]`) and PDF (`@react-pdf/renderer` in `src/reports/pdf/`). PDF is generated server-side on first download via `GET /api/audits/[id]/report.pdf` and cached in the private `reports` Supabase bucket.

### Billing (`src/lib/stripe/`, `src/app/api/stripe/`)

- **Checkout** (`/api/stripe/checkout`) — handles first-time `stripe_customer_id` creation with a race-safe pattern: `.update().is('stripe_customer_id', null).select('id')`; if 0 rows return, the loser deletes its orphan customer via `stripe.customers.del(...)`.
- **Webhook** (`/api/stripe/webhook`) — verifies signature, dedups via `billing_events.stripe_event_id` UNIQUE constraint, then dispatches to `handlers.ts`. Every customer-keyed update asserts exactly-one row matched (`assertExactlyOneProfileMatched`); 0 or >1 rows throws + Sentry warning.
- **Portal** (`/api/stripe/portal`) — Stripe Billing Portal redirect for `/settings/billing`.
- **Access gate** — `assertCanRunAudit` returns ok for `subscription_status in ('active','trialing')` OR `audit_credits > 0`. The `increment_audit_credits` RPC is `security definer` and atomic.

### Auth & route protection

Supabase SSR via `src/middleware.ts` → `src/lib/supabase/middleware.ts`. Protects `(app)/*`. Three Supabase client variants:
- `src/lib/supabase/client.ts` — browser, anon key
- `src/lib/supabase/server.ts` — RSC/route handlers, anon key + cookies
- `src/lib/supabase/admin.ts` — service role, bypasses RLS. **Only used inside Inngest workers and webhooks.** Never import from a route handler that should respect RLS.

### Database & storage

Migrations are forward-only under `supabase/migrations/`. Schema is in `0001_init.sql`; storage buckets in `0002_storage.sql` (`bills`) and `0003_reports_storage.sql` (`reports`); credit RPC in `0004_billing_helpers.sql`; CHECK constraints + atomic refund RPC in `0005_check_constraints_and_refund_rpc.sql`.

RLS: every user-data table has owner-read; bill_* tables join through `audits.user_id`. Service-role writes bypass RLS — only Inngest workers and Stripe webhook handlers should write.

### Observability

- **Sentry** — DSN-gated, replays explicitly disabled (PII discipline), `tunnelRoute: '/monitoring'`, sourcemaps uploaded when `SENTRY_AUTH_TOKEN` is set.
- **PostHog** — typed event registry in `src/lib/analytics/events.ts` (discriminated union — adding a new event without the right shape is a typecheck failure). Server-side flushes immediately (serverless-safe).
- **`/api/health`** — DB + Stripe + Anthropic-key-presence (no API call to save credit).

## Operating Principles (Distilled)

Full rationale in [`SPEC.md` §1](./SPEC.md). The non-negotiables for day-to-day work:

1. **Phase discipline.** Phases 0–4 done; Phase 5 in progress per HANDOFF.md. Don't introduce features outside the current phase without a discussion.
2. **TypeScript strict + `noUncheckedIndexedAccess`.** No `any`. Use `unknown` and narrow.
3. **Zod at every external boundary** — API routes, Inngest events, LLM output, env vars, form inputs. Validate at the edge, trust internally.
4. **Idempotent Inngest jobs.** Side effects in `step.run`. Status guards on transitions. Idempotency keys on `inngest.send`.
5. **No PII in logs.** Account IDs and rule IDs only — never raw bill text, full phone numbers, employee names, or recipient emails. `redactDetails()` in `llm.ts` is the helper for sanitizing error payloads.
6. **Don't substitute the locked stack.** Tech choices in [`SPEC.md` §2](./SPEC.md) are intentional. Raise a question before swapping.
7. **No premature abstraction.** Three call sites before extracting a util. Two implementations before an interface.
8. **The rules engine is the product.** Test rules seriously: positive + negative + edge cases. Snapshot tests on the report side are fine.

## Test Strategy

- **Unit (Vitest):** every rule, schema validation, helpers. Mocks for Supabase/Anthropic/Stripe clients — see `tests/audits/api.test.ts` for the established mocking patterns.
- **Integration:** `runRules` against full bill fixture; Inngest functions with mocked clients; route handlers via direct function call.
- **LLM extraction (gated, costs API credit):** `RUN_LLM_TESTS=1 pnpm test:llm` — runs real Claude against fixtures and asserts schema parses, totals match within $1.
- **E2E (Playwright):** happy-path signup → buy → upload → see report → download PDF. Public-surface specs (`landing.spec.ts`, `health.spec.ts`) run without auth.
- **Multi-tenant isolation:** `tests/audits/rls-isolation.test.ts` simulates user A reading user B's audit and asserts 404 across every authenticated audit route.

When mocking `@/inngest/client`, use `vi.hoisted()` for the mock fn — `vi.mock` factories are hoisted above closure variables.

## Things to Skip (per SPEC.md §10)

Don't build any of these without a discussion: carrier API integrations, auto-negotiation, email-based bill ingest, mobile app, multi-org/team accounts, white-label theming, multi-currency, non-US carriers, wireline bills, real-time chat, A/B infra, i18n.

## Marker Conventions

- `TODO(domain)` — domain logic Justin will refine. Don't fill these in.
- `TODO(launch)` — pre-launch polish. Tackle in Phase 5.
- `TODO(blocker)` — must fix before merging the current work. Should never sit unresolved.
