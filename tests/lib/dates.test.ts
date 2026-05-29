import { describe, expect, it } from 'vitest';

import {
  formatIsoDateDisplay,
  formatIsoDatePeriod,
  formatUtcYyyyMmDd,
} from '@/lib/dates';

describe('formatIsoDateDisplay', () => {
  it('formats date-only ISO strings as calendar dates (no TZ shift)', () => {
    expect(formatIsoDateDisplay('2026-04-01')).toBe('Apr 1, 2026');
    expect(formatIsoDateDisplay('2026-04-30')).toBe('Apr 30, 2026');
  });

  it('returns em dash for null/empty', () => {
    expect(formatIsoDateDisplay(null)).toBe('—');
    expect(formatIsoDateDisplay(undefined)).toBe('—');
  });
});

describe('formatIsoDatePeriod', () => {
  it('joins start and end with an en dash', () => {
    expect(formatIsoDatePeriod('2026-04-01', '2026-04-30')).toBe(
      'Apr 1, 2026 – Apr 30, 2026',
    );
  });
});

describe('formatUtcYyyyMmDd', () => {
  it('uses UTC components', () => {
    const d = new Date('2026-05-25T23:00:00.000Z');
    expect(formatUtcYyyyMmDd(d)).toBe('2026-05-25');
  });
});
