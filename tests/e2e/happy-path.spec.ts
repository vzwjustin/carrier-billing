// Phase 5 task #11 — full happy path E2E.
//
// signup → email confirm (admin shortcut) → login → buy one-time → upload bill
// → wait for completion → see report → download PDF → share link.
//
// SKIPPED BY DEFAULT. Set `RUN_FULL_E2E=1` plus the env vars listed in
// tests/e2e/README.md to run against your sandbox. See that README for
// prerequisites (Supabase, Stripe test mode, Anthropic API key, Inngest dev
// server, the Next dev server).
//
// SETUP — what the operator must do before the run:
//   1. Apply all migrations under supabase/migrations/ to a clean Supabase
//      project. Storage buckets `bills` and `reports` must exist (private).
//   2. Create the two Stripe test-mode prices (one-time $149 + sub $99/mo) and
//      put their IDs in the dev server's .env.local — the same prices the
//      app reads via STRIPE_PRICE_ID_ONE_TIME / STRIPE_PRICE_ID_SUBSCRIPTION.
//   3. Run `pnpm dlx inngest-cli@latest dev` so the worker can pick up the
//      `bill.uploaded` event the upload route emits.
//   4. Make sure ANTHROPIC_API_KEY is set in the dev server's env so the
//      extraction pipeline can complete (this spec waits up to 5 min on it).
//   5. Place a small synthetic PDF at tests/fixtures/e2e-sample.pdf. Another
//      agent generates the canonical fixtures; this spec falls back to a
//      test.skip() if the file is missing so the suite stays green when the
//      fixture isn't checked in yet.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { cleanupUser, confirmUserViaAdminApi, randomEmail } from './setup';

const RUN_FULL_E2E = process.env.RUN_FULL_E2E === '1';
const d = RUN_FULL_E2E ? test.describe : test.describe.skip;

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/e2e-sample.pdf');
const STRIPE_TEST_CARD = process.env.E2E_STRIPE_TEST_CARD ?? '4242424242424242';
const TEST_PASSWORD = 'CarrierAudit-E2E-Pa55!';
const COMPLETION_TIMEOUT_MS = 5 * 60 * 1000; // up to 5 min for Anthropic.

// State carried across the chained tests in this describe block.
interface SharedState {
  email: string;
  userId: string;
  auditId: string | null;
  shareUrl: string | null;
}

const state: SharedState = {
  email: '',
  userId: '',
  auditId: null,
  shareUrl: null,
};

d('CarrierAudit happy path', () => {
  test.describe.configure({ mode: 'serial', timeout: COMPLETION_TIMEOUT_MS + 60_000 });

  test.beforeAll(() => {
    if (!existsSync(FIXTURE_PATH)) {
      test.skip(true, `Missing fixture at ${FIXTURE_PATH} — generate one to run this spec.`);
    }
    state.email = randomEmail();
  });

  test.afterAll(async () => {
    if (process.env.E2E_CLEANUP === '1' && state.email) {
      try {
        await cleanupUser(state.email);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[happy-path] cleanup failed:', err);
      }
    }
  });

  test('a. signup shows "check your email"', async ({ page }) => {
    await page.goto('/signup');
    await page.locator('input[type="email"]').fill(state.email);
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign up|create account/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 15_000 });
  });

  test('b. confirm user via Supabase admin API', async () => {
    state.userId = await confirmUserViaAdminApi(state.email);
    expect(state.userId).toMatch(/[0-9a-f-]{36}/i);
  });

  test('c. login redirects to /dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(state.email);
    await page.locator('input[type="password"]').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /log in|sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  });

  test('d. buy one-time audit via Stripe Checkout', async ({ page }) => {
    await page.goto('/pricing');
    // Pricing card CTA copy is "Buy one audit" (src/components/marketing/pricing-cards.tsx).
    await page.getByRole('button', { name: /buy one audit/i }).click();

    // /api/stripe/checkout returns a 303 to the hosted Checkout page.
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });

    // Stripe's hosted checkout uses fields keyed by `name`. These selectors
    // are stable across Stripe's current rollout but may need a refresh if
    // Stripe changes the form — see tests/e2e/README.md "Known limitations".
    await page.locator('input[name="cardNumber"]').fill(STRIPE_TEST_CARD);
    await page.locator('input[name="cardExpiry"]').fill('12 / 34');
    await page.locator('input[name="cardCvc"]').fill('123');
    await page.locator('input[name="billingName"]').fill('CarrierAudit E2E');

    // Some flows include a country/postal — fill if present, ignore otherwise.
    const postal = page.locator('input[name="billingPostalCode"]');
    if (await postal.count()) {
      await postal.fill('94103');
    }

    await page.getByRole('button', { name: /pay|subscribe/i }).first().click();

    await page.waitForURL(/\/dashboard\?checkout=success/, { timeout: 60_000 });
  });

  test('e. upload bill PDF and arrive at /audits/:id', async ({ page }) => {
    await page.goto('/audits/new');

    // The dropzone wraps a hidden <input type="file"> (src/components/upload/dropzone.tsx).
    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);

    await page.getByRole('button', { name: /start audit|upload|submit/i }).click();

    await page.waitForURL(/\/audits\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const match = page.url().match(/\/audits\/([0-9a-f-]{36})/);
    expect(match).not.toBeNull();
    state.auditId = match ? (match[1] ?? null) : null;
    expect(state.auditId).not.toBeNull();
  });

  test('f. wait for the audit to reach status=completed', async ({ request }) => {
    expect(state.auditId).not.toBeNull();
    const auditId = state.auditId as string;

    const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
    let lastStatus = 'unknown';
    while (Date.now() < deadline) {
      const res = await request.get(`/api/audits/${auditId}/status`);
      if (res.ok()) {
        const body = (await res.json()) as { status?: string };
        lastStatus = body.status ?? 'unknown';
        if (lastStatus === 'completed') {
          break;
        }
        if (lastStatus === 'failed') {
          throw new Error(`Audit ${auditId} failed during E2E run`);
        }
      }
      await new Promise<void>((r) => setTimeout(r, 5_000));
    }
    expect(lastStatus).toBe('completed');
  });

  test('g. report shows monthly savings + at least one finding', async ({ page }) => {
    expect(state.auditId).not.toBeNull();
    await page.goto(`/audits/${state.auditId}`);
    await expect(page.getByText(/estimated monthly savings/i)).toBeVisible({
      timeout: 30_000,
    });
    // Finding cards live inside src/components/report/finding-card.tsx — match
    // by the severity badge text any finding will render.
    const severityBadge = page
      .getByText(/^(high|medium|low|info)$/i)
      .first();
    await expect(severityBadge).toBeVisible({ timeout: 10_000 });
  });

  test('h. download PDF returns application/pdf', async ({ page }) => {
    expect(state.auditId).not.toBeNull();
    await page.goto(`/audits/${state.auditId}`);

    // The Download button opens the report PDF in a new tab — wait for popup
    // and assert the response content-type. ReportActions calls window.open()
    // (src/components/report/report-actions.tsx).
    const pagePromise: Promise<Page> = page.context().waitForEvent('page');
    await page.getByRole('button', { name: /download pdf/i }).click();
    const popup = await pagePromise;
    const response = await popup.waitForResponse(
      (r) => r.url().includes('/api/audits/') && r.url().includes('/pdf'),
      { timeout: 60_000 },
    );
    expect(response.status()).toBe(200);
    const ct = response.headers()['content-type'] ?? '';
    expect(ct).toContain('application/pdf');
    await popup.close();
  });

  test('i. share link renders the report in an anonymous context', async ({
    page,
    browser,
  }) => {
    expect(state.auditId).not.toBeNull();
    await page.goto(`/audits/${state.auditId}`);

    // Grant clipboard permission so navigator.clipboard.readText works.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.getByRole('button', { name: /share link/i }).click();
    await expect(page.getByText(/copied/i)).toBeVisible({ timeout: 15_000 });

    const shareUrl = await page.evaluate<string>(async () => {
      return await navigator.clipboard.readText();
    });
    expect(shareUrl).toMatch(/\/share\/[A-Za-z0-9_-]{8,}/);
    state.shareUrl = shareUrl;

    // Open in a brand new (logged-out) context to confirm the public viewer
    // works without auth.
    const anon: BrowserContext = await browser.newContext();
    try {
      const anonPage = await anon.newPage();
      await anonPage.goto(shareUrl);
      await expect(
        anonPage.getByText(/estimated monthly savings/i),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await anon.close();
    }
  });
});
