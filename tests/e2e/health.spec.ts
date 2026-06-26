// Phase 5 E2E for /api/health. Uses the request fixture instead of page
// navigation so the JSON body is parsed directly without HTML wrapping.
import { expect, test } from '@playwright/test';

test('GET /api/health returns 200 with status + checks keys', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);

  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toHaveProperty('status');
  expect(body).toHaveProperty('checks');
  expect(body.status).toBe('ok');

  const checks = body.checks as Record<string, unknown>;
  expect(checks).toHaveProperty('app');
  expect(checks).not.toHaveProperty('db');
  expect(checks).not.toHaveProperty('stripe');
  expect(checks).not.toHaveProperty('anthropic');
});
