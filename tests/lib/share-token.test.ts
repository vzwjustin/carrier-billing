import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isShareTokenExpired } from '@/lib/share-token';

describe('isShareTokenExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T18:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects NULL expiry when the column is available', () => {
    expect(isShareTokenExpired(null)).toBe(true);
  });

  it('allows NULL when the expiry column is unavailable (schema fallback)', () => {
    expect(isShareTokenExpired(null, false)).toBe(false);
  });

  it('rejects past expiry', () => {
    expect(isShareTokenExpired('2026-05-28T00:00:00.000Z')).toBe(true);
  });

  it('allows future expiry', () => {
    expect(isShareTokenExpired('2026-06-01T00:00:00.000Z')).toBe(false);
  });

  it('rejects invalid expiry strings', () => {
    expect(isShareTokenExpired('not-a-date')).toBe(true);
  });
});
