import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  expiresWithinDays,
  isExpired,
  isHotspotDevice,
  isPlanNameDeprecated,
  monthsUntil,
  sumLineCharges,
} from '@/rules/helpers';
import { makeLine, TEST_TODAY } from './fixtures';

describe('monthsUntil', () => {
  it('positive when date is in the future', () => {
    expect(monthsUntil('2026-08-08', TEST_TODAY)).toBe(3);
  });
  it('negative when date is in the past', () => {
    expect(monthsUntil('2026-02-08', TEST_TODAY)).toBe(-3);
  });
  it('accepts a Date object', () => {
    expect(monthsUntil(new Date('2026-06-08'), TEST_TODAY)).toBe(1);
  });
});

describe('daysUntil', () => {
  it('positive in the future', () => {
    expect(daysUntil('2026-05-18', TEST_TODAY)).toBe(10);
  });
  it('negative in the past', () => {
    expect(daysUntil('2026-04-28', TEST_TODAY)).toBe(-10);
  });
  it('zero on the same calendar day', () => {
    expect(daysUntil('2026-05-08', TEST_TODAY)).toBe(0);
  });
});

describe('isExpired', () => {
  it('false for null', () => {
    expect(isExpired(null, TEST_TODAY)).toBe(false);
  });
  it('false for today (not yet past)', () => {
    expect(isExpired('2026-05-08', TEST_TODAY)).toBe(false);
  });
  it('true for yesterday', () => {
    expect(isExpired('2026-05-07', TEST_TODAY)).toBe(true);
  });
  it('false for tomorrow', () => {
    expect(isExpired('2026-05-09', TEST_TODAY)).toBe(false);
  });
});

describe('expiresWithinDays', () => {
  it('false for null', () => {
    expect(expiresWithinDays(null, TEST_TODAY, 30)).toBe(false);
  });
  it('true within window', () => {
    expect(expiresWithinDays('2026-05-20', TEST_TODAY, 30)).toBe(true);
  });
  it('false outside window', () => {
    expect(expiresWithinDays('2026-07-20', TEST_TODAY, 30)).toBe(false);
  });
  it('false when already expired', () => {
    expect(expiresWithinDays('2026-04-01', TEST_TODAY, 30)).toBe(false);
  });
  it('true at the boundary', () => {
    expect(expiresWithinDays('2026-06-07', TEST_TODAY, 30)).toBe(true);
  });
});

describe('isHotspotDevice', () => {
  it('detects jetpack', () => {
    expect(isHotspotDevice('Verizon Jetpack MiFi 8800L')).toBe(true);
  });
  it('detects mifi case-insensitive', () => {
    expect(isHotspotDevice('mifi unit')).toBe(true);
  });
  it('detects "hotspot" in name', () => {
    expect(isHotspotDevice('Inseego 5G Hotspot')).toBe(true);
  });
  it('false for a phone', () => {
    expect(isHotspotDevice('iPhone 15 Pro Max')).toBe(false);
  });
  it('false for null', () => {
    expect(isHotspotDevice(null)).toBe(false);
  });
});

describe('isPlanNameDeprecated', () => {
  it('matches a known legacy pattern', () => {
    expect(isPlanNameDeprecated('More Everything 10GB', [/More\s*Everything/i])).toBe(true);
  });
  it('false for null', () => {
    expect(isPlanNameDeprecated(null, [/anything/])).toBe(false);
  });
  it('false when no patterns match', () => {
    expect(isPlanNameDeprecated('Business Unlimited Pro', [/More\s*Everything/i])).toBe(false);
  });
});

describe('sumLineCharges', () => {
  it('adds base + features + dpp and applies signed credits', () => {
    const line = makeLine({
      plan_base_cents: 5000,
      features: [{ name: 'Insurance', category: 'insurance', monthly_cents: 1500 }],
      dpp_installments: [
        { device: 'iPhone 15', monthly_cents: 3000, remaining_payments: 10, total_payments: 36 },
      ],
      credits: [
        { name: 'Loyalty', monthly_cents: -1000, expires_on: null, is_promo: true },
      ],
    });
    expect(sumLineCharges(line)).toBe(8500);
  });
});
