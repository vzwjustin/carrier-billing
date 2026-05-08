# `scripts/bootstrap.ts`

One-shot provisioning script for CarrierAudit. Reads keys from `.env.local`,
then idempotently creates the external resources the app needs.

```bash
pnpm bootstrap                      # default — provisions everything possible
pnpm bootstrap --dry-run            # describe actions without calling any API
```

## What it does

| Step | Action | Idempotent? | Required env |
|------|--------|-------------|--------------|
| (a) Stripe products & prices | Creates a `one_time` ($149) and a monthly `subscription` ($99) product+price. Marker metadata `carrieraudit_kind` is used to dedupe. | yes | `STRIPE_SECRET_KEY` |
| (b) Stripe webhook endpoint  | (Opt-in) Creates a webhook at `<url>` listening for `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`, `invoice.payment_failed`. The signing secret is printed once — capture it immediately. | yes (URL-keyed) | `STRIPE_SECRET_KEY` |
| (c) Supabase migrations      | Prints the four `supabase/migrations/*.sql` files in order. Does **not** run them — apply via `supabase db push` or paste them into the Dashboard SQL editor. | n/a | none |
| (d) Supabase storage buckets | Creates private buckets `bills` and `reports`. | yes | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| (e) Resend sender domain     | (Opt-in) Creates a Resend domain and prints the DNS records you need to add. Verification is async — finish it in the Resend dashboard. | yes (Resend dedupes by name) | `RESEND_API_KEY` |
| (f) Summary                  | Prints every sub-task's status and a list of env keys you should copy back into `.env.local`. | — | — |

## Flags

| Flag | Default | Notes |
|------|---------|-------|
| `--skip-stripe` | off | Skip the entire Stripe step. |
| `--skip-supabase` | off | Skip the storage bucket step. |
| `--skip-resend` | off | Skip the Resend step (it's already opt-in via `--resend-domain`). |
| `--stripe-webhook=<url>` | unset | Create/refresh a Stripe webhook endpoint at this URL. |
| `--resend-domain=<domain>` | unset | Create a Resend sender domain. |
| `--dry-run` | off | Print the planned actions; make no API calls. |
| `-h`, `--help` | off | Print usage and exit. |

## Prerequisites

1. `.env.local` must exist with at least the keys for the sub-tasks you're running.
   The script will fail loudly with a list of missing keys, not a stack trace.
2. `pnpm install` has been run so `stripe`, `@supabase/supabase-js`, and `resend`
   are available — the script does NOT add new dependencies.
3. The Stripe key should be a test-mode key (`sk_test_...`) for first runs.
4. The Supabase service-role key is required because anonymous keys cannot
   create buckets.

## Expected output (happy path)

```
CarrierAudit bootstrap
cwd: /path/to/carrieraudit
Loaded 18 keys from .env.local at /path/to/carrieraudit/.env.local

Stripe — products & prices
[OK] Product (one_time): prod_XXXXXXXXXXXX (created)
[OK] Price   (one_time): price_XXXXXXXXXXXX $149.00 (created)
[OK] Product (subscription): prod_YYYYYYYYYYYY (created)
[OK] Price   (subscription): price_YYYYYYYYYYYY $99.00/mo (created)

Supabase — database migrations
[INFO] This script does not run SQL migrations directly.
[INFO] Apply the following SQL files in order from supabase/migrations/:
    - 0001_init.sql
    - 0002_storage.sql
    - 0003_reports_storage.sql
    - 0004_billing_helpers.sql

Supabase — storage buckets
[OK] Bucket "bills" created (private).
[OK] Bucket "reports" created (private).

Summary
[OK] Stripe products & prices
[OK] Supabase migrations (info)
     Run the 4 migrations manually before using the app.
[OK] Supabase storage buckets
[SKIP] Resend sender domain
     No --resend-domain flag provided.

Update your .env.local
[INFO] Set the following keys (values shown only once — copy now):
  STRIPE_PRICE_ID_ONE_TIME=price_XXXXXXXXXXXX
  STRIPE_PRICE_ID_SUBSCRIPTION=price_YYYYYYYYYYYY

Bootstrap finished.
```

## Re-running

Re-running the script is safe. Stripe products are matched by metadata,
prices by `unit_amount`+recurring shape, Supabase buckets by name, and
Resend dedupes by domain. Already-provisioned resources are reported as
`(existing)` instead of `(created)`.

## What it does *not* do

- Run SQL migrations (use `supabase db push` or the SQL editor).
- Verify Resend DNS records (verification is async at the registrar).
- Mutate `process.env`. Env values are read in-memory and not exported.
- Print or log the value of any secret that already exists in `.env.local`.
  Newly-issued secrets (Stripe webhook signing secret) are printed exactly
  once at the moment of creation.

---

# `scripts/anonymize-bill.ts`

True PDF anonymization for committing real-world bill PDFs as test fixtures.

```bash
pnpm tsx scripts/anonymize-bill.ts <input.pdf> <output.pdf> [--dry-run]
```

Loads the input PDF, extracts text via `pdf-parse`, applies a redaction map,
then emits a brand-new PDF containing only the cleaned text plus a sidecar
`<output>.json` with the full mapping for human review. Redactions:

| Kind | Match | Replacement |
|------|-------|-------------|
| Phone numbers | `\d{3}[-. ]\d{3}[-. ]\d{4}`, `\d{10}`, `(\d{3}) \d{3}-\d{4}` | `555-555-####` |
| Account numbers | 12 consecutive digits | `XXXXXXXX####` (last 4 preserved) |
| Labeled names | `User\|Name\|Employee\|Contact\|Bill To\|Account Holder: <Name>` | Fake name from a static pool |

`--dry-run` prints the would-be redactions without writing.

> **NOTE:** This produces a TEXT-replicated anonymized PDF — the original
> visual layout is lost. For visual fidelity, use a tool that supports
> positional matching (e.g., `qpdf` + `pdftotext bbox`).

---

# Generating fixtures

```bash
pnpm fixtures:generate
```

Runs `scripts/generate-fixtures.ts`, which writes synthetic
`*.expected.json` ExtractedBill goldens to `tests/fixtures/bills/`. Values
are obviously synthetic — phone numbers use the 555 prefix, account numbers
are `0001`/`0002`/..., employees are `Employee A`/`Employee B`/.... The
generator validates each fixture against `ExtractedBillSchema` before
writing, so schema drift is caught at generation time.

The committed JSONs feed two test suites:

- `tests/extraction/fixtures.test.ts` — always-on, asserts each JSON parses
  against `ExtractedBillSchema` and that account totals sum correctly.
- `tests/extraction/llm.test.ts` — gated by `RUN_LLM_TESTS=1`
  (`pnpm test:llm`). For each `<basename>.expected.json` it looks for a
  sibling `<basename>.pdf` and, if present, calls `extractBill` and compares
  carrier / account count / line count (±10%) / total charges (±$1).

## Adding a real anonymized bill as a fixture

1. Take a real PDF business wireless bill (Verizon, AT&T, or T-Mobile).
2. Anonymize it:
   ```
   pnpm tsx scripts/anonymize-bill.ts ~/Downloads/real-bill.pdf \
     tests/fixtures/bills/<carrier>-<descriptor>.pdf
   ```
3. Inspect the sidecar `<carrier>-<descriptor>.json` and confirm every
   redaction is correct. Delete it (or keep it gitignored) — it's a review
   artifact, not a fixture.
4. Hand-author a matching `<carrier>-<descriptor>.expected.json` next to the
   PDF, capturing the expected `ExtractedBill` shape. Pattern-match on the
   synthetic fixtures already in the directory.
5. Run `pnpm test` — `fixtures.test.ts` will validate the new JSON parses.
6. Run `RUN_LLM_TESTS=1 pnpm test:llm` to confirm the live extractor produces
   output within the invariants for the new pair. (Uses API credit.)

Never commit a real bill PDF or one whose redaction sidecar shows residual
PII. See `CLAUDE.md` §1#9.
