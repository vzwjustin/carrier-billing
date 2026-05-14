# CarrierAudit Bug Review

The headline: this code has clearly been through multiple security passes and most of the obvious bug classes (signature verification, idempotency, CAS, SSRF, ordering guards, share-token TTL, PII redaction) are addressed thoughtfully. No unambiguous critical bug found. What was found: one likely-fires noisy-failure path, one auth-boundary gap, several integrity/edge issues, and a known CSP weakness.

## CRITICAL

None confirmed. Several spots looked suspicious at first glance but unwound on a second read (the credit-grant flow with `grant_credit_once`, the `mark-in-flight` CAS, the share-token entropy, the SSRF guard, the dedupe hashing).

## HIGH

### H-1. `assertExactlyOneProfileMatched` throws on `customer.subscription.created` when profile hasn't been linked yet — Stripe will retry until it eventually succeeds
File: `src/lib/stripe/handlers.ts:538-578` + `220-225` (`applySubscriptionPatchWithOrderGuard`).

Flow on signup → checkout (subscription mode):
1. `checkout.session.completed` normally arrives first → sets `stripe_customer_id` on profile via `updateProfile(supabase, userId, …)` keyed by `id=userId`.
2. `customer.subscription.created` arrives — `applySubscriptionPatchWithOrderGuard` does `.eq('stripe_customer_id', customerId)`.

Stripe does NOT guarantee event ordering. If `customer.subscription.created` lands first, the profile won't yet have `stripe_customer_id`, and `assertExactlyOneProfileMatched` for a non-terminal event throws:

```
throw new Error(`profile lookup by stripe_customer_id matched 0 rows (${eventType})`);
```

That bubbles into the route's 5xx path, Stripe retries with exponential backoff. Eventually checkout lands, the profile gets the customer id, and the retry succeeds. But you'll burn Sentry warnings + Stripe retries on signups where the subscription event beats the checkout event.

Fix: add `customer.subscription.created` to a "tolerant 0-row" set OR fall back to looking up by `client_reference_id` / `metadata.userId` (via `deriveUserIdFromEventObject`) when the customer-id lookup yields 0 rows.

### H-3. Inbound email path is not rate-limited
File: `src/app/api/inbound/email/route.ts:258-353`.

The HTTP `POST /api/audits` is rate-limited at 20/hr/user. The inbound-email path runs `assertCanRunAudit` and `decrementAuditCreditAtomically` but bypasses the per-user rate limit. A subscription user has no credit cost, so an attacker who can submit to an inbound provider can DOS the Inngest workers and burn Anthropic credits.

Fix: apply a per-user rate limit (`consumeRateLimit({ key: 'inbound:'+userId, … })`) before queuing the bill.

### H-4. CSP allows `'unsafe-inline'` in `script-src` in production
File: `src/middleware.ts:27-34`.

```
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  ...(isProd ? [] : ["'unsafe-eval'"]),
  ...
```

`'unsafe-inline'` in `script-src` in production fully neutralizes the XSS protection benefit of CSP. HANDOFF.md acknowledges this as a P2 follow-up (nonce-based CSP). Already tracked, included here for completeness.

## MEDIUM

### M-2. `audits.storage_path` has no shape validation; worker trusts it blindly
File: `src/inngest/functions/process-bill.ts:381-432`.

If service-role code (e.g. inbound email path) ever writes a malformed `storage_path` (path traversal, absolute path), `supabase.storage.from('bills').download(storagePath)` could in principle return the wrong file. Supabase storage doesn't follow `..` outside the bucket, so practical impact is low. But there's no validation.

Fix: validate `storage_path` matches `^[a-f0-9-]{36}/[a-f0-9-]{36}/[A-Za-z0-9._-]+$` on insert, or add a CHECK constraint.

### M-3. `share_token` length is hard-coded in two places
File: `src/app/api/audits/[id]/share/route.ts:30-32` vs `src/app/share/[token]/page.tsx:53` and the PDF route's regex `^[A-Za-z0-9_-]{32}$`.

`randomBytes(24).toString('base64url')` produces exactly 32 chars (stable). If you ever change token byte count, three sites need updating in lockstep.

### M-4. `safeFilename` returns `'bill.pdf'` when cleaned name is empty, even for non-PDF inputs
File: `src/app/api/audits/route.ts:69-75`. Cosmetic — logs/storage path say "bill.pdf" when content might actually be X12/EDI.

### M-6. Dead defense-in-depth check
File: `src/app/api/audits/[id]/report.pdf/route.ts:167-181`.

RLS on `audits` limits SELECT to `auth.uid() = user_id`, so `data.user_id !== user.id` can never fire unless RLS regresses. Not a bug — just dead code. Keep the comment so a future refactor doesn't drop the guard if it ever switches to admin client.

### M-7. Repeated `customers.del` reconciliation noises Sentry
File: `src/app/api/stripe/checkout/route.ts:188-202`.

If Stripe `customers.del` returns "already deleted", the captured exception fires on every retry. Sentry will dedup, but worth suppressing the specific "resource missing" case.

### M-8. Vestigial `previousStatus` lie in replay cron
File: `src/inngest/functions/replay-billing-events.ts:236-239`.

```
previousStatus: row.processed_status === null ? 'failed' : row.processed_status,
```

Credit grant now keys off `billing_events.credit_granted`, not `previousStatus`, so this doesn't affect money today. Any future handler branch that reads `previousStatus` would see a lie. Audit when adding new branches.

### M-9. Retry idempotency key can collide if `inngest.send` half-succeeds
File: `src/app/api/audits/[id]/retry/route.ts:155-191`.

The key is `bill.uploaded-retry-${retryCount}`. If `inngest.send` actually succeeded but the response read failed and the catch rolled back `retry_count`, the next user retry recomputes the same key and Inngest treats it as a duplicate. Result: stuck audit.

Likelihood: low. Fix: track the inngest send key separately or include `Date.now()` in the key.

### M-10. `findings.affected_line_ids` is `uuid[]` with no FK
File: `supabase/migrations/0001_init.sql:165-166`.

If `persistFindings` runs before `bill_lines` is fully visible, ids could orphan. Service-role + same transaction makes this very unlikely. Ops note only.

## LOW

### L-1. `profiles.email` drifts from `auth.users.email`
`profiles.email` is set once via the `handle_new_user` trigger and never updated. If a user changes their email at the auth level, the past-due notice goes to the old address. Verify there's an email-change handler.

### L-2. No cleanup cron for expired `share_token_expires_at` rows — minor hygiene.

### L-3. New `audits` statuses require migration + code in lockstep (CHECK constraint enforces this). Note for ops.

### L-4. `next.config.ts` doesn't set `X-Permitted-Cross-Domain-Policies` (Flash/PDF policy file). Niche, cheap to add.

### L-5. PDF route public/token path could use `no-store` instead of `private, max-age=0, must-revalidate` for stronger defense against intermediary caches that key on `?token=`. Unlikely with current headers, but more defensive.

### L-6. `tryParseAndValidate` in `llm.ts` only strips ``` ```json ``` fencing once at start; nested fencing fails. Cosmetic.

### L-7. OCR poll timeout (5 min) + LLM (12 min wall) leaves 7 min for LLM after worst-case OCR. Tight on big multi-page scanned bills.

### L-8. Invariant: post-migration 0013, all `audits` writes MUST use the admin client. Future PR using the anon `supabase` client for an audits write will silently 0-row.

### L-9. `mark-failed` overwrites `failure_reason` on each retry — can mask earlier root cause.

### L-10. `verifyHmac` only accepts hex. Future providers that send base64 (e.g. SendGrid) will break — future-proofing note.

## Areas NOT fully reviewed (token budget)
- `src/rules/*` (rule definitions and runner)
- Most of the extraction pipeline beyond `llm.ts` (`pdf.ts`, `detect.ts`, `edi811/*`)
- `src/components/*` (low-priority per brief)
- Tests directory
- Migrations 0009, 0010, 0011, 0015
- `src/inngest/events.ts` (zod boundary parser)
- `src/app/(app)/settings/*` server actions

## Summary

- 0 confirmed CRITICAL bugs
- 1 likely HIGH that will fire on real signups (H-1: subscription.created arriving before checkout.session.completed)
- 1 HIGH worth fixing (H-3: inbound email lacks rate limit)
- 1 HIGH already tracked (H-4: CSP unsafe-inline)
- ~7 MEDIUM
- ~10 LOW notes

Honest take: this codebase has been audited well. The findings above are mostly residual edge cases and one ordering-related noisy-failure path (H-1) worth fixing first.
