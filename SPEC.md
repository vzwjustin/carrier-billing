# CarrierAudit — Claude Code Build Brief

> **Read this entire document before writing any code.** This is the canonical spec. If anything below conflicts with your default behavior, this document wins. Stop and ask before deviating.

---

## 0. Mission

Build **CarrierAudit**, a SaaS that lets a business owner, office manager, MSP, or fractional CFO upload a PDF of their business wireless bill (Verizon, AT&T, or T-Mobile) and receive an audit report identifying wasted spend, wrong rate plans, missing discounts, expired promo credits, and other waste patterns — with estimated monthly savings and recommended actions.

**Core value prop in one sentence:** Upload your wireless bill → get a professional audit with quantified savings in under 5 minutes.

**Primary buyer:** Office managers / IT leads / CFOs at 20–500 employee US businesses with $2K–$50K/month wireless spend, plus MSPs and TEM consultants who resell or use it for their clients.

**Pricing model (build for both):**
- One-time audit: **$149 per bill**
- Subscription: **$99/month** for unlimited audits + monthly drift alerts
- Future: white-label tier for MSPs (do not build yet)

---

## 1. Operating Principles

These are non-negotiable. Apply them on every file, every commit, every decision.

1. **Phase discipline.** Build in the phase order specified in §6. Do not skip ahead. Do not start Phase 2 features while Phase 1 is incomplete.
2. **Stop points are real.** At each `STOP` marker in §6, end your turn with a status report and wait for human review. Do not auto-proceed.
3. **Opinionated defaults.** Every choice in this spec is intentional. If you disagree, raise it as a question — don't silently substitute.
4. **TypeScript strict.** `"strict": true`, `"noUncheckedIndexedAccess": true`. No `any`. If you need to escape the type system, use `unknown` and narrow.
5. **Zod everywhere there's a boundary.** API routes, Inngest functions, LLM outputs, env vars, form inputs. Validate at the edge, then trust internally.
6. **No premature abstraction.** Three call sites before you extract a util. Two implementations before you make an interface.
7. **Test the rules engine seriously.** It's the product. Snapshot tests on the report side are fine; the rules engine needs unit tests with real fixture data.
8. **Idempotent jobs.** Every Inngest function must be safe to retry. Use deterministic IDs, upserts, and `step.run` for side effects.
9. **Don't log PII or bill contents.** Customer phone numbers, employee names, and account numbers are sensitive. Logs get account IDs and rule IDs, not raw data.
10. **Ship to production from day one.** Vercel preview deploys for every PR. Main branch deploys to prod. No long-lived feature branches.

---

## 2. Tech Stack — Locked

Do not substitute without raising a question.

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15** App Router, TypeScript | Standard, fast, good Vercel integration |
| Styling | **Tailwind CSS v4** + **shadcn/ui** | Speed, consistency, owns its source |
| DB / Auth / Storage | **Supabase** (Postgres + Auth + Storage) | One vendor, RLS, fast setup |
| Background jobs | **Inngest** | Durable, retryable, observable, free tier generous |
| Payments | **Stripe** Checkout + Customer Portal + Webhooks | Standard |
| LLM | **Anthropic Claude Sonnet 4.6** (`claude-sonnet-4-6`) | Best structured extraction; native PDF input support |
| OCR fallback | **AWS Textract** | For scanned/image-only bills |
| PDF text extraction | **pdf-parse** + **pdfjs-dist** | Lightweight, no native deps |
| Report PDF generation | **@react-pdf/renderer** | React-native PDF; same components for web + PDF |
| Forms | **react-hook-form** + **zod** | Standard |
| Email | **Resend** | Simple, good DX |
| Validation | **zod** | Standard |
| Testing | **Vitest** + **Playwright** | Unit + E2E |
| Hosting | **Vercel** | Standard |
| Analytics | **PostHog** (self-hosted EU or cloud) | Product analytics + feature flags |
| Error tracking | **Sentry** | Standard |

### Environment variables

Every env var must be declared in `src/env.ts` using `@t3-oss/env-nextjs` + zod. App must fail to boot if any required var is missing.

```ts
// src/env.ts — required vars (non-exhaustive)
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
STRIPE_PRICE_ID_ONE_TIME
STRIPE_PRICE_ID_SUBSCRIPTION
INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY
RESEND_API_KEY
SENTRY_DSN
NEXT_PUBLIC_POSTHOG_KEY
NEXT_PUBLIC_APP_URL
```

---

## 3. Repository Layout

```
carrieraudit/
├── README.md
├── CLAUDE.md                          # this file
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── components.json                    # shadcn config
├── vitest.config.ts
├── playwright.config.ts
├── .env.example
│
├── src/
│   ├── env.ts                         # validated env
│   ├── app/                           # Next.js App Router
│   │   ├── (marketing)/
│   │   │   └── page.tsx               # landing
│   │   ├── (auth)/
│   │   │   ├── login/
│   │   │   └── signup/
│   │   ├── (app)/
│   │   │   ├── dashboard/
│   │   │   ├── audits/
│   │   │   │   ├── new/               # upload flow
│   │   │   │   └── [id]/              # report viewer
│   │   │   └── settings/
│   │   ├── api/
│   │   │   ├── upload/                # presigned upload
│   │   │   ├── stripe/
│   │   │   │   ├── checkout/
│   │   │   │   └── webhook/
│   │   │   ├── inngest/               # Inngest serve handler
│   │   │   └── share/[token]/         # public report links
│   │   └── layout.tsx
│   │
│   ├── components/
│   │   ├── ui/                        # shadcn primitives
│   │   ├── upload/
│   │   ├── report/                    # web + react-pdf shared
│   │   └── marketing/
│   │
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── server.ts
│   │   │   ├── client.ts
│   │   │   └── admin.ts               # service role
│   │   ├── stripe/
│   │   ├── anthropic/
│   │   ├── textract/
│   │   ├── resend/
│   │   └── utils.ts
│   │
│   ├── extraction/
│   │   ├── carriers/
│   │   │   ├── verizon.ts             # carrier-specific normalization
│   │   │   ├── att.ts
│   │   │   └── tmobile.ts
│   │   ├── detect.ts                  # carrier detection from raw text
│   │   ├── pdf.ts                     # pdf-parse wrapper
│   │   ├── llm.ts                     # Claude extraction call
│   │   ├── ocr.ts                     # Textract fallback
│   │   ├── pipeline.ts                # orchestrator
│   │   └── schema.ts                  # zod schemas for extracted bills
│   │
│   ├── rules/
│   │   ├── types.ts                   # Rule, Finding, RuleContext
│   │   ├── registry.ts                # all rules registered here
│   │   ├── runner.ts                  # executes all rules against bill
│   │   ├── helpers.ts                 # shared rule utilities
│   │   └── definitions/               # one file per rule
│   │       ├── expired-promo-credit.ts
│   │       ├── completed-device-payment.ts
│   │       ├── orphan-insurance.ts
│   │       ├── stale-international-feature.ts
│   │       ├── unused-mifi-line.ts
│   │       └── ...
│   │
│   ├── reports/
│   │   ├── builder.ts                 # findings → report data
│   │   ├── pdf/                       # @react-pdf/renderer components
│   │   └── web/                       # web viewer components
│   │
│   ├── inngest/
│   │   ├── client.ts
│   │   └── functions/
│   │       ├── process-bill.ts        # main pipeline
│   │       └── send-report-email.ts
│   │
│   └── types/
│       └── index.ts                   # shared types
│
├── supabase/
│   ├── migrations/
│   │   └── 0001_init.sql
│   └── seed.sql
│
├── tests/
│   ├── fixtures/
│   │   └── bills/                     # anonymized PDF + extracted JSON pairs
│   ├── extraction/
│   ├── rules/
│   └── e2e/
│
└── scripts/
    ├── seed-rules.ts
    └── anonymize-bill.ts              # for adding test fixtures
```

---

## 4. Data Model

Use Supabase migrations (SQL). All tables get `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz default now()`. RLS enabled on every user-data table.

### Tables

```sql
-- Users mirror Supabase auth.users
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  company_name text,
  stripe_customer_id text unique,
  subscription_status text,        -- 'active' | 'canceled' | 'past_due' | null
  subscription_id text,
  audit_credits int not null default 0,  -- one-time purchases add credits
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Each uploaded bill becomes an audit
create table public.audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
    -- 'pending' | 'extracting' | 'analyzing' | 'completed' | 'failed'
  carrier text,                    -- 'verizon' | 'att' | 'tmobile' | 'unknown'
  storage_path text not null,      -- path in Supabase Storage
  original_filename text not null,
  file_size_bytes bigint,
  page_count int,
  billing_period_start date,
  billing_period_end date,
  total_charges_cents bigint,
  account_count int,
  line_count int,
  estimated_monthly_savings_cents bigint default 0,
  estimated_annual_savings_cents bigint default 0,
  finding_count int default 0,
  high_severity_count int default 0,
  share_token text unique,         -- for public read-only links
  failure_reason text,
  inngest_run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index audits_user_id_idx on public.audits(user_id);
create index audits_status_idx on public.audits(status);

-- Normalized billing data extracted from the PDF
create table public.bill_accounts (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  account_number_masked text,      -- last 4 only
  account_label text,
  total_charges_cents bigint,
  taxes_fees_cents bigint,
  raw jsonb not null               -- full parsed account block
);

create table public.bill_lines (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  account_id uuid not null references public.bill_accounts(id) on delete cascade,
  mdn_masked text,                 -- last 4 only of phone number
  user_label text,                 -- nickname/employee name if present
  device_description text,
  plan_name text,
  plan_base_cents bigint,
  data_used_gb numeric(8,2),
  voice_used_min int,
  sms_used_count int,
  is_suspended boolean default false,
  is_active_dpp boolean default false,  -- has device payment installments
  raw jsonb not null
);

create index bill_lines_audit_id_idx on public.bill_lines(audit_id);

create table public.bill_features (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.bill_lines(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  name text not null,
  category text,                   -- 'insurance' | 'international' | 'cloud' | 'addon' | 'other'
  monthly_charge_cents bigint not null
);

create table public.bill_credits (
  id uuid primary key default gen_random_uuid(),
  line_id uuid references public.bill_lines(id) on delete cascade,
  account_id uuid references public.bill_accounts(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  name text not null,
  monthly_amount_cents bigint not null,
  expires_on date,
  is_promo boolean default true
);

create table public.bill_dpp_installments (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.bill_lines(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  device_description text,
  monthly_payment_cents bigint not null,
  remaining_payments int,
  total_payments int
);

-- Findings are the rules engine output
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  rule_id text not null,           -- e.g. 'expired_promo_credit'
  severity text not null,          -- 'high' | 'medium' | 'low' | 'info'
  title text not null,
  description text not null,
  recommended_action text not null,
  estimated_monthly_savings_cents bigint not null default 0,
  confidence numeric(3,2) not null default 1.0,  -- 0.00 - 1.00
  affected_line_ids uuid[],
  affected_account_ids uuid[],
  evidence jsonb,                  -- structured data backing the finding
  created_at timestamptz not null default now()
);

create index findings_audit_id_idx on public.findings(audit_id);
create index findings_severity_idx on public.findings(severity);

-- Audit log for billing events
create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  stripe_event_id text unique not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
```

### RLS policies (the critical ones)

```sql
alter table public.profiles enable row level security;
alter table public.audits enable row level security;
alter table public.bill_accounts enable row level security;
alter table public.bill_lines enable row level security;
alter table public.bill_features enable row level security;
alter table public.bill_credits enable row level security;
alter table public.bill_dpp_installments enable row level security;
alter table public.findings enable row level security;
alter table public.billing_events enable row level security;

-- Profiles: a user can read/update only their own profile
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);
create policy "own profile update" on public.profiles
  for update using (auth.uid() = id);

-- Audits: user owns their audits
create policy "own audits all" on public.audits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- All bill_* and findings tables: visible if user owns the parent audit
create policy "own audit children read" on public.bill_lines
  for select using (
    exists (select 1 from public.audits a where a.id = audit_id and a.user_id = auth.uid())
  );
-- (replicate the pattern for bill_accounts, bill_features, bill_credits, bill_dpp_installments, findings)
```

Service-role writes (from Inngest workers) bypass RLS — use the admin client only inside `src/lib/supabase/admin.ts`.

---

## 5. Core Type Definitions

Build these in `src/extraction/schema.ts` and `src/rules/types.ts`. The extracted-bill schema is the contract between the LLM and the rest of the system. **Treat it like an API.**

```ts
// src/extraction/schema.ts
import { z } from 'zod';

export const Money = z.object({
  cents: z.number().int(),
}).transform((v) => v.cents);

export const ExtractedFeatureSchema = z.object({
  name: z.string(),
  category: z.enum(['insurance', 'international', 'cloud', 'hotspot', 'addon', 'other']).default('other'),
  monthly_cents: z.number().int().nonnegative(),
});

export const ExtractedCreditSchema = z.object({
  name: z.string(),
  monthly_cents: z.number().int(),       // negative or positive — see prompt
  expires_on: z.string().date().nullable(),
  is_promo: z.boolean().default(true),
});

export const ExtractedDppSchema = z.object({
  device: z.string(),
  monthly_cents: z.number().int().nonnegative(),
  remaining_payments: z.number().int().nullable(),
  total_payments: z.number().int().nullable(),
});

export const ExtractedLineSchema = z.object({
  mdn_last4: z.string().regex(/^\d{4}$/).nullable(),
  user_label: z.string().nullable(),
  device: z.string().nullable(),
  plan_name: z.string().nullable(),
  plan_base_cents: z.number().int().nonnegative().nullable(),
  data_used_gb: z.number().nonnegative().nullable(),
  voice_used_min: z.number().int().nonnegative().nullable(),
  sms_used_count: z.number().int().nonnegative().nullable(),
  is_suspended: z.boolean().default(false),
  features: z.array(ExtractedFeatureSchema).default([]),
  credits: z.array(ExtractedCreditSchema).default([]),
  dpp_installments: z.array(ExtractedDppSchema).default([]),
});

export const ExtractedAccountSchema = z.object({
  account_number_last4: z.string().regex(/^\d{4}$/).nullable(),
  label: z.string().nullable(),
  total_charges_cents: z.number().int().nonnegative(),
  taxes_fees_cents: z.number().int().nonnegative().nullable(),
  account_level_credits: z.array(ExtractedCreditSchema).default([]),
  lines: z.array(ExtractedLineSchema),
});

export const ExtractedBillSchema = z.object({
  carrier: z.enum(['verizon', 'att', 'tmobile', 'unknown']),
  billing_period_start: z.string().date(),
  billing_period_end: z.string().date(),
  total_charges_cents: z.number().int().nonnegative(),
  accounts: z.array(ExtractedAccountSchema),
  notes: z.array(z.string()).default([]),  // LLM observations
});

export type ExtractedBill = z.infer<typeof ExtractedBillSchema>;
```

```ts
// src/rules/types.ts
import type { ExtractedBill } from '@/extraction/schema';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export type Finding = {
  rule_id: string;
  severity: Severity;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;       // 0.0 - 1.0
  affected_line_indexes: number[];
  affected_account_indexes: number[];
  evidence: Record<string, unknown>;
};

export type RuleContext = {
  bill: ExtractedBill;
  today: Date;             // injected for testability
  carrier: ExtractedBill['carrier'];
};

export type Rule = {
  id: string;              // stable, snake_case, e.g. 'expired_promo_credit'
  title: string;           // human title for the rule itself
  appliesTo: ExtractedBill['carrier'][] | 'all';
  evaluate: (ctx: RuleContext) => Finding[] | Promise<Finding[]>;
};
```

---

## 6. Phase Plan — Build in This Order

Each phase ends with a `STOP` checkpoint. Do not proceed past `STOP` without human review.

### Phase 0 — Project Setup

**Goal:** A deployable empty app with auth, env validation, CI, and observability wired up.

Tasks:
1. `pnpm create next-app` with TypeScript, Tailwind, App Router, ESLint
2. Install: `@supabase/ssr`, `@supabase/supabase-js`, `stripe`, `@anthropic-ai/sdk`, `inngest`, `zod`, `@t3-oss/env-nextjs`, `react-hook-form`, `@hookform/resolvers`, `resend`, `@react-pdf/renderer`, `pdf-parse`, `pdfjs-dist`, `@aws-sdk/client-textract`, `posthog-js`, `posthog-node`, `@sentry/nextjs`
3. Install dev: `vitest`, `@vitejs/plugin-react`, `@testing-library/react`, `playwright`, `@playwright/test`
4. Init shadcn/ui with neutral base color: `pnpm dlx shadcn@latest init`
5. Add shadcn components: `button card input label form table tabs sheet dialog toast alert badge separator skeleton`
6. Create `src/env.ts` per §2
7. Create Supabase project, run migration `0001_init.sql` from §4
8. Wire Supabase auth: `/login`, `/signup`, `/auth/callback`, middleware that protects `(app)/*` routes
9. Stripe: webhook route at `/api/stripe/webhook` with signature verification and `billing_events` insert
10. Inngest: serve handler at `/api/inngest`, hello-world function
11. Sentry init for both client + server
12. PostHog init (client only for now)
13. `.env.example` complete
14. `README.md` with setup instructions
15. GitHub Actions: lint + typecheck + vitest on PR
16. Vercel project connected; main → prod, PRs → previews

**Acceptance:**
- `pnpm dev` runs cleanly
- Sign up + log in works
- Empty `(app)/dashboard` page loads behind auth
- Stripe webhook returns 200 on test event
- Inngest dashboard shows the hello function

**STOP** → report status, list any decisions deferred, wait for review.

---

### Phase 1 — PDF Upload + Extraction Pipeline

**Goal:** User uploads a PDF; an Inngest job extracts structured bill data and persists it. No rules, no report yet.

Tasks:

1. **Upload UI** at `/audits/new`
   - Drag-and-drop zone (single file, PDF only, max 25 MB)
   - On submit: get presigned upload URL from `/api/upload`, PUT to Supabase Storage bucket `bills`, then `POST /api/audits` to create the `audits` row and trigger Inngest event `bill.uploaded`
   - Redirect to `/audits/[id]` which polls status

2. **Storage bucket** `bills` — private, server-side write, RLS read for owner via signed URL

3. **Inngest function** `process-bill`
   - Trigger: `bill.uploaded` event with `{ auditId, userId, storagePath }`
   - Steps (each in `step.run`):
     - `fetch-pdf` — download from Supabase Storage to a Buffer
     - `extract-text` — `pdf-parse` → raw text + page count; if text length < 500 chars, mark needs-OCR
     - `ocr-fallback` (conditional) — Textract `StartDocumentAnalysis` async; poll
     - `detect-carrier` — heuristic on raw text (regex on header strings: `verizon wireless`, `at&t`, `t-mobile`)
     - `llm-extract` — call Claude with the prompt in §7 and the PDF as native input
     - `validate` — `ExtractedBillSchema.parse`; on fail, retry once with the validation error appended
     - `persist` — insert `bill_accounts`, `bill_lines`, `bill_features`, `bill_credits`, `bill_dpp_installments`; update `audits` with totals + status `analyzing`
     - For now, leave status as `analyzing` at the end (Phase 2 will flip to `completed`)

4. **Audit detail page** `/audits/[id]`
   - Server component reads audit + status
   - Client component polls `/api/audits/[id]/status` every 2s while status is in `pending|extracting|analyzing`
   - Show a stepper: Uploading → Extracting → Analyzing → Done
   - Show extracted summary: carrier, billing period, account count, line count, total charges

5. **Anonymization script** `scripts/anonymize-bill.ts`
   - CLI: `pnpm anonymize <input.pdf> <output.pdf>`
   - Replaces phone numbers, account numbers, names with realistic fakes
   - Used for test fixtures

6. **Test fixtures**
   - At least 3 anonymized fixtures per carrier (9 total) committed under `tests/fixtures/bills/`
   - For each fixture, a paired `.expected.json` with the extracted bill (golden snapshot)

7. **Tests**
   - `tests/extraction/detect.test.ts` — carrier detection on raw text fixtures
   - `tests/extraction/llm.test.ts` — runs the LLM on each fixture and asserts schema parse passes (skipped in CI by default; run via `pnpm test:llm`)

**Acceptance:**
- Upload a real (anonymized) Verizon Business bill → status reaches `analyzing` → DB has populated `bill_*` rows
- Repeat for an AT&T and a T-Mobile bill
- Failure path: corrupt PDF → status `failed` with `failure_reason` set, user sees error UI

**STOP** → demo the extraction with 3 sample bills. Justin reviews the schema fit and rule prompt quality before Phase 2.

---

### Phase 2 — Rules Engine + First 10 Rules

**Goal:** Findings persist for each audit. Status reaches `completed`.

Tasks:

1. **Rule infrastructure**
   - `src/rules/types.ts` per §5
   - `src/rules/registry.ts` — exports `ALL_RULES: Rule[]`
   - `src/rules/runner.ts` — `runRules(ctx) → Finding[]`, runs all rules, catches per-rule errors and logs them without failing the audit
   - `src/rules/helpers.ts` — utilities like `monthsUntil(date, today)`, `sumLineCharges(line)`, `findCreditByName(line, pattern)`

2. **Add to `process-bill` Inngest function**
   - New step `run-rules` after `persist`
   - New step `persist-findings` — inserts into `findings`
   - Final step `mark-completed` — updates `audits` with totals (`finding_count`, `high_severity_count`, `estimated_monthly_savings_cents`, `estimated_annual_savings_cents = monthly * 12`), status `completed`, `completed_at = now()`

3. **First 10 rules** — implement these as placeholders Justin will refine. Each rule gets its own file under `src/rules/definitions/`. **Justin will provide the full domain knowledge for each rule's logic in a follow-up — for now, implement the structure correctly with conservative starter logic and clear `TODO(domain)` comments where his expertise needs to fill in thresholds and edge cases.**

   Starter rules to scaffold:
   1. `expired_promo_credit` — detect credits with `expires_on` in the past or within 30 days
   2. `completed_device_payment_still_billed` — DPP with `remaining_payments === 0` but `monthly_cents > 0`
   3. `orphan_insurance` — insurance feature on a line with no active device (suspended OR no device description)
   4. `stale_international_feature` — international feature present > 60 days with no international usage indicators (heuristic: flag for review)
   5. `unused_mifi_or_jetpack_line` — line with hotspot device + `data_used_gb < 0.1`
   6. `suspended_line_billed` — `is_suspended === true` and `plan_base_cents > 0`
   7. `legacy_unlimited_plan` — plan name matches deprecated unlimited tier patterns *(Justin provides regex)*
   8. `data_overage_pattern` — flag lines using >80% of plan threshold for upgrade consideration
   9. `duplicate_protection_features` — multiple insurance/protection features on same line
   10. `account_level_promo_about_to_expire` — account-level credit expiring within 60 days

4. **Tests**
   - `tests/rules/<rule_id>.test.ts` for each rule with positive + negative fixtures
   - `tests/rules/runner.test.ts` — full pipeline against a fixture, snapshot the findings array

5. **Status API update** — `/api/audits/[id]/status` returns `{ status, progress: 0-100, currentStep }`

**Acceptance:**
- Sample bills produce realistic findings with quantified savings
- Rule failure doesn't crash the audit; it logs to Sentry and continues
- All 10 rules have passing unit tests

**STOP** → Justin reviews findings on real bills before Phase 3. He will provide refined domain logic per rule.

---

### Phase 3 — Report Viewer + PDF Export

**Goal:** Beautiful, shareable audit reports — web view and PDF download.

Tasks:

1. **Web report** at `/audits/[id]`
   - Hero: estimated monthly + annual savings (big numbers)
   - Summary cards: total findings, by severity
   - Findings list grouped by severity, then by category
   - Each finding card: title, description, recommended action, estimated savings, confidence indicator, affected lines (collapsible)
   - Bill summary section: carrier, period, accounts, lines, total charges
   - Download PDF button
   - Share button → generates `share_token`, copy link to clipboard

2. **PDF report** via `@react-pdf/renderer`
   - Cover page with company logo placeholder, audit ID, period
   - Executive summary page
   - Findings pages (one per finding for high severity, grouped for medium/low)
   - Methodology + disclaimer page
   - Generated server-side on first download, cached in Supabase Storage at `reports/{auditId}.pdf`

3. **Public share route** `/share/[token]`
   - Read-only report viewer
   - No login required
   - Server-side validates token against `audits.share_token`
   - Same React components as authenticated viewer, with sharing UI hidden

4. **Email** via Resend — `audit-completed` email with link to report
   - Inngest function `send-report-email` triggered after `mark-completed`

**Acceptance:**
- Real bill produces a report Justin would actually send to an MSP customer
- PDF renders correctly with no overflow/clipping
- Share link works in incognito

**STOP** → Justin reviews report quality.

---

### Phase 4 — Billing & Access Control

**Goal:** Users can only run audits they've paid for.

Tasks:

1. **Pricing page** `/pricing`
   - Two cards: One-time $149, Subscription $99/mo
   - Both → Stripe Checkout

2. **Stripe Checkout API** `/api/stripe/checkout`
   - Server-side; creates session with `client_reference_id = userId`
   - Success URL: `/dashboard?checkout=success`
   - Cancel URL: `/pricing`

3. **Stripe Webhook** `/api/stripe/webhook`
   - Verify signature
   - Idempotency: check `billing_events.stripe_event_id` first
   - Handle: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - On one-time purchase: increment `profiles.audit_credits` by 1
   - On sub events: update `profiles.subscription_status` + `subscription_id`

4. **Access control**
   - On `/audits/new` submit: check user has `audit_credits > 0` OR `subscription_status === 'active'`
   - If sub: no decrement
   - If one-time: decrement `audit_credits` atomically when audit is created (not when uploaded — when status moves out of `pending`)
   - If neither: redirect to `/pricing`

5. **Customer portal** at `/settings/billing`
   - Stripe billing portal session redirect

6. **Tests**
   - Webhook idempotency test (replay same event → no double-credit)
   - Access control test (no credits + no sub → 402)

**Acceptance:**
- Stripe test mode: buy one-time → credit appears → run audit → credit gone
- Subscribe → unlimited audits → cancel → no more audits after period end

**STOP**

---

### Phase 5 — Landing Page, Polish, Launch Prep

**Goal:** Public-ready.

Tasks:

1. **Landing page** `/` — hero, sample report screenshot, 3-step "how it works", testimonial placeholder, FAQ, pricing teaser, footer
2. **Dashboard** with audit history table
3. **Empty states everywhere** (no audits yet, no findings, no subscription)
4. **Loading skeletons** on every async surface
5. **Mobile responsive** review pass
6. **Privacy policy + Terms** placeholder pages
7. **PostHog event tracking**: `audit_uploaded`, `audit_completed`, `report_viewed`, `report_pdf_downloaded`, `report_shared`, `checkout_started`, `checkout_completed`
8. **Sentry sourcemaps** uploaded
9. **`/health` endpoint** that checks DB + Stripe + Anthropic reachability
10. **README** updated with full deploy instructions
11. **Playwright E2E**: full happy path — sign up → buy → upload → see report

**Acceptance:**
- Lighthouse score >90 on landing page
- E2E test passes
- All env vars documented

**STOP** → Justin's launch decision.

---

## 7. The Extraction Prompt

This is the most important LLM call in the system. Implement it in `src/extraction/llm.ts`. The PDF goes in as a native Anthropic PDF document block; the prompt instructs structured output.

```ts
// src/extraction/llm.ts
import Anthropic from '@anthropic-ai/sdk';
import { ExtractedBillSchema, type ExtractedBill } from './schema';
import { env } from '@/env';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a senior telecom billing analyst with 15 years of experience auditing US business wireless bills from Verizon, AT&T, and T-Mobile.

Your job: extract a complete, normalized representation of the uploaded business wireless bill into strict JSON matching the schema provided.

CRITICAL RULES:
1. Output ONLY a single JSON object. No prose, no markdown, no code fences.
2. All money values are integer cents. $43.99 → 4399. Never use floats for money.
3. Phone numbers and account numbers: capture ONLY the last 4 digits, in a string field. Never output full PII.
4. Dates: ISO 8601 (YYYY-MM-DD).
5. Credits: monthly_cents is the SIGNED amount as it appears on the bill. A $10/mo discount line item shows as -1000.
6. If a value is genuinely not present, use null. Do not guess. Do not invent.
7. Suspended lines: still extract them; set is_suspended: true. Their plan_base_cents is the amount still being billed (often $0, sometimes not).
8. Multi-account bills: each account in the "accounts" array. Account-level credits go in account_level_credits.
9. Device Payment Plan (DPP / Equipment Installment Plan / Next Up): each device installment is a separate dpp_installments entry on the line. monthly_cents is the installment amount. If the bill shows "X of Y" (e.g., "12 of 36"), set remaining_payments = Y - X and total_payments = Y.
10. Features classification:
    - insurance: anything named like "Mobile Protect", "Asurion", "Total Mobile Protection", "Protection<360>", "Wireless Phone Protection", "AppleCare"
    - international: "TravelPass", "International Plan", "Global Plus", "International Roaming"
    - cloud: "Verizon Cloud", "AT&T Photo Storage", "Microsoft 365 add-on through carrier"
    - hotspot: "Mobile Hotspot Premium", extra hotspot data
    - addon: anything else recurring (premium voicemail, content streaming bundle, etc.)
    - other: only if you cannot classify
11. Plans: capture the exact plan name as printed. Common Verizon Business: "Business Unlimited Pro 2.0", "Business Unlimited Plus 2.0", "Business Unlimited Start 2.0". Common AT&T Business: "Business Unlimited Premium", "Business Unlimited Performance", "Business Unlimited Starter". Common T-Mobile for Business: "Business Unlimited Ultimate", "Business Unlimited Advanced", "Business Unlimited Select".
12. Notes array: include observations that don't fit the schema but might matter — e.g., "Bill includes prior balance", "Two pages appear to be missing", "Several lines have promo credits expiring next month".

CARRIER DETECTION: Set carrier based on the bill header. If ambiguous, set "unknown".

If the document is not a US business wireless bill, output: {"error": "not_a_wireless_bill"} and stop.`;

const USER_PROMPT = `Extract the bill into JSON matching this schema:

{
  "carrier": "verizon" | "att" | "tmobile" | "unknown",
  "billing_period_start": "YYYY-MM-DD",
  "billing_period_end": "YYYY-MM-DD",
  "total_charges_cents": integer,
  "accounts": [
    {
      "account_number_last4": "1234" | null,
      "label": "string or null",
      "total_charges_cents": integer,
      "taxes_fees_cents": integer | null,
      "account_level_credits": [
        { "name": "string", "monthly_cents": integer, "expires_on": "YYYY-MM-DD" | null, "is_promo": boolean }
      ],
      "lines": [
        {
          "mdn_last4": "1234" | null,
          "user_label": "string or null",
          "device": "string or null",
          "plan_name": "string or null",
          "plan_base_cents": integer | null,
          "data_used_gb": number | null,
          "voice_used_min": integer | null,
          "sms_used_count": integer | null,
          "is_suspended": boolean,
          "features": [{ "name": "string", "category": "insurance|international|cloud|hotspot|addon|other", "monthly_cents": integer }],
          "credits": [{ "name": "string", "monthly_cents": integer, "expires_on": "YYYY-MM-DD" | null, "is_promo": boolean }],
          "dpp_installments": [{ "device": "string", "monthly_cents": integer, "remaining_payments": integer | null, "total_payments": integer | null }]
        }
      ]
    }
  ],
  "notes": ["observations"]
}

Output the JSON only.`;

export async function extractBill(pdfBuffer: Buffer): Promise<ExtractedBill> {
  const base64 = pdfBuffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: USER_PROMPT },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text response');

  const raw = textBlock.text.trim();
  // Strip accidental code fences just in case
  const jsonText = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new ExtractionError('LLM returned non-JSON', { raw: jsonText.slice(0, 1000) });
  }

  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw new ExtractionError('Not a wireless bill', parsed);
  }

  const result = ExtractedBillSchema.safeParse(parsed);
  if (!result.success) {
    throw new ExtractionError('Schema validation failed', { issues: result.error.issues, raw: parsed });
  }
  return result.data;
}

export class ExtractionError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
    this.name = 'ExtractionError';
  }
}
```

**Retry strategy:** On `ExtractionError` with schema validation failure, retry once with the original messages plus an assistant turn echoing the bad output and a user turn saying *"Your previous response failed validation: <issues>. Output corrected JSON only."* If that fails too, mark the audit failed and surface to the user.

---

## 8. Rule Implementation Pattern

Every rule looks like this. Justin will fill in domain logic per rule. Use this template.

```ts
// src/rules/definitions/expired-promo-credit.ts
import type { Rule } from '../types';
import { addDays, isBefore } from 'date-fns';

export const expiredPromoCreditRule: Rule = {
  id: 'expired_promo_credit',
  title: 'Expired or expiring promotional credit',
  appliesTo: 'all',
  evaluate: ({ bill, today }) => {
    const findings: ReturnType<Rule['evaluate']> extends Promise<infer T> ? T : never = [];
    const soonCutoff = addDays(today, 30);

    bill.accounts.forEach((account, accountIndex) => {
      // account-level credits
      account.account_level_credits.forEach((credit) => {
        if (!credit.expires_on) return;
        const exp = new Date(credit.expires_on);
        if (isBefore(exp, soonCutoff)) {
          const isExpired = isBefore(exp, today);
          findings.push({
            rule_id: 'expired_promo_credit',
            severity: isExpired ? 'high' : 'medium',
            title: isExpired
              ? `Account credit "${credit.name}" has expired`
              : `Account credit "${credit.name}" expires within 30 days`,
            description: `An account-level promotional credit of ${formatCents(Math.abs(credit.monthly_cents))}/mo ${isExpired ? 'has expired on' : 'will expire on'} ${credit.expires_on}.`,
            recommended_action: isExpired
              ? 'Contact your Verizon Business representative to negotiate a renewal or replacement promotional credit.'
              : 'Contact your representative now to renew this credit before it falls off and your bill increases.',
            estimated_monthly_savings_cents: Math.abs(credit.monthly_cents),
            confidence: 0.95,
            affected_line_indexes: [],
            affected_account_indexes: [accountIndex],
            evidence: { credit_name: credit.name, expires_on: credit.expires_on },
          });
        }
      });

      // line-level credits — same pattern
      account.lines.forEach((line, lineIndex) => {
        line.credits.forEach((credit) => {
          // ... same shape
        });
      });
    });

    return findings;
  },
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
```

Register in `src/rules/registry.ts`:

```ts
import { expiredPromoCreditRule } from './definitions/expired-promo-credit';
// ... import all rules

export const ALL_RULES = [
  expiredPromoCreditRule,
  completedDevicePaymentRule,
  orphanInsuranceRule,
  staleInternationalFeatureRule,
  unusedMifiLineRule,
  suspendedLineBilledRule,
  legacyUnlimitedPlanRule,
  dataOveragePatternRule,
  duplicateProtectionFeaturesRule,
  accountPromoExpiringSoonRule,
];
```

---

## 9. Test Strategy

### Unit (Vitest)
- Every rule: positive case (finding fires), negative case (finding does not fire), edge cases
- Schema validation: malformed inputs rejected
- Helpers: `monthsUntil`, currency formatting, etc.

### Integration
- `runRules` against a full fixture bill → snapshot findings array
- Inngest functions: mocked Supabase + Anthropic clients

### LLM extraction (gated)
- `pnpm test:llm` runs against real fixtures and burns API credit; not in CI by default
- Asserts: schema parses, total_charges within 1¢ of expected, line count matches expected

### E2E (Playwright)
- One canonical happy path test: signup → buy → upload → see report → download PDF

---

## 10. Things to Explicitly Skip

Do not build any of these in v1, even if they seem nice. Raise a question if you think one is essential.

- Carrier API integrations (no Verizon/ATT/TMobile API auth)
- Auto-negotiation features
- Email parsing of bills (PDF only)
- Mobile app
- Multi-org / team accounts
- White-label theming
- Multi-currency (USD only)
- Non-US carriers
- Wireline / fiber / cable bills (wireless only)
- Real-time chat / customer support widgets
- Affiliate / referral system
- A/B testing infrastructure
- i18n

---

## 11. Failure Modes & Edge Cases to Handle

Build defensively for these:

1. **PDF is encrypted/password-protected** → fail fast with clear error
2. **PDF is not a wireless bill** → LLM returns `{error: "not_a_wireless_bill"}` → user-friendly message
3. **PDF is a scanned image (no extractable text)** → fall through to Textract OCR
4. **PDF >25 MB** → reject at upload
5. **PDF >100 pages** → warn the user that processing may be slow
6. **LLM returns malformed JSON** → retry once with the parse error fed back, then fail
7. **LLM returns valid JSON that fails schema** → same retry pattern
8. **Stripe webhook retried** → idempotency via `billing_events.stripe_event_id` unique constraint
9. **User cancels subscription mid-audit** → finish the in-flight audit, block new ones
10. **Inngest function times out** → max function duration 15min; OCR step has its own timeout; partial failure leaves audit in `failed` state with reason
11. **Concurrent audits same user** → allowed; each gets its own credit decrement (atomic)
12. **Empty bill (no lines)** → mark `failed` with reason "no lines extracted"

---

## 12. Quality Gates (CI)

PR must pass:
- `pnpm lint` (eslint + prettier)
- `pnpm typecheck`
- `pnpm test` (unit + integration)
- Build succeeds

PR should include:
- Updated `.env.example` if any new vars
- Migration file if schema changed
- Test for new rule or new code path

---

## 13. Definition of Done (per phase)

A phase is done when:
- All listed tasks complete
- All acceptance criteria verified by Justin on real bills
- All listed tests passing in CI
- No `TODO(blocker)` comments remain (`TODO(domain)` is fine — those are for Justin to fill in)
- `STOP` checkpoint report posted with: what shipped, what's deferred, any open questions

---

## 14. First Action

When you start, do this first:

1. Read this entire document.
2. Confirm the spec back to Justin in 5 bullets — your understanding of (a) product, (b) tech stack, (c) phase plan, (d) immediate next steps for Phase 0, (e) any concerns or questions.
3. Wait for Justin's "go".
4. Then begin Phase 0.

Do not start coding before step 3.
