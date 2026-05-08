// TODO(phase-5.1): full happy path requires sandbox seeding; this spec covers the auth-free public surface only.
//
// Phase 5 E2E for the public marketing + auth-entry surface. Hits everything
// reachable without seeded Supabase users or Stripe sandbox state. The
// Playwright config (playwright.config.ts) auto-starts `pnpm dev` for these
// tests, so they require a working `.env.local`.
import { expect, test } from '@playwright/test';

test.describe('landing surface', () => {
  test('landing page renders and links to pricing + login', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/CarrierAudit/i);

    const heroCta = page.getByRole('link', { name: /run a free preview/i });
    await expect(heroCta).toBeVisible();

    // Pricing link in nav (use the first match — there may be multiple
    // "See pricing" CTAs across the page).
    const pricingLink = page.getByRole('link', { name: /^pricing$/i }).first();
    await pricingLink.click();
    await expect(page).toHaveURL(/\/pricing$/);

    // Both pricing tiers present with the canonical price points.
    await expect(page.getByText('$149')).toBeVisible();
    await expect(page.getByText('$99')).toBeVisible();

    // Log in entry from the marketing nav.
    const loginLink = page.getByRole('link', { name: /log in/i }).first();
    await loginLink.click();
    await expect(page).toHaveURL(/\/login/);

    // Login form has email + password inputs.
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });
});
