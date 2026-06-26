import { describe, expect, it } from 'vitest';

import {
  autoMap,
  extractLast4,
  parseBoolish,
  parseGigabytes,
  parseMoneyToCents,
  parseNonNegInt,
  type CanonicalField,
} from '@/extraction/csv/mapping';

/**
 * Heuristic auto-mapper coverage. We exercise the three carriers we ship
 * support for (Verizon, AT&T, T-Mobile). Each scenario uses a representative
 * set of headers; assertions check both that the canonical fields we expect
 * get a non-null mapping AND that the mapping points at a sensible column.
 */
describe('autoMap heuristics', () => {
  it('maps a Verizon-style header set', () => {
    const headers = [
      'Account Number',
      'Account Name',
      'Wireless Number',
      'User Name',
      'Equipment',
      'Plan',
      'Monthly Plan Charge',
      'Data Usage (GB)',
      'Status',
    ];
    const mapping = autoMap(headers);
    expect(mapping.mdn_last4).toBe('Wireless Number');
    expect(mapping.user_label).toBe('User Name');
    expect(mapping.device).toBe('Equipment');
    expect(mapping.plan_name).toBe('Plan');
    expect(mapping.plan_base_cents).toBe('Monthly Plan Charge');
    expect(mapping.data_used_gb).toBe('Data Usage (GB)');
    expect(mapping.is_suspended).toBe('Status');
    expect(mapping.account_number_last4).toBe('Account Number');
    expect(mapping.account_label).toBe('Account Name');
  });

  it('maps an AT&T-style header set', () => {
    const headers = [
      'Foundation Account Number',
      'Foundation Name',
      'Mobile Number',
      'User Description',
      'Device',
      'Plan Name',
      'MRC',
      'Data Used',
      'Minutes Used',
      'Messages',
      'Suspended',
    ];
    const mapping = autoMap(headers);
    expect(mapping.mdn_last4).toBe('Mobile Number');
    expect(mapping.user_label).toBe('User Description');
    expect(mapping.device).toBe('Device');
    expect(mapping.plan_name).toBe('Plan Name');
    expect(mapping.plan_base_cents).toBe('MRC');
    expect(mapping.data_used_gb).toBe('Data Used');
    expect(mapping.voice_used_min).toBe('Minutes Used');
    expect(mapping.sms_used_count).toBe('Messages');
    expect(mapping.is_suspended).toBe('Suspended');
    // Account label heuristic should grab Foundation Name not Foundation Account Number
    expect(mapping.account_label).toBe('Foundation Name');
    expect(mapping.account_number_last4).toBe('Foundation Account Number');
  });

  it('maps a T-Mobile-style header set', () => {
    const headers = [
      'BAN',
      'MSISDN',
      'Subscriber Name',
      'Device',
      'Rate Plan',
      'Recurring Charge',
      'GB Used',
      'Minutes',
      'SMS',
      'Line Status',
    ];
    const mapping = autoMap(headers);
    expect(mapping.mdn_last4).toBe('MSISDN');
    expect(mapping.user_label).toBe('Subscriber Name');
    expect(mapping.device).toBe('Device');
    expect(mapping.plan_name).toBe('Rate Plan');
    expect(mapping.plan_base_cents).toBe('Recurring Charge');
    expect(mapping.data_used_gb).toBe('GB Used');
    expect(mapping.voice_used_min).toBe('Minutes');
    expect(mapping.sms_used_count).toBe('SMS');
    expect(mapping.is_suspended).toBe('Line Status');
    expect(mapping.account_number_last4).toBe('BAN');
  });

  it('returns empty mappings when no headers match', () => {
    const mapping = autoMap(['Color', 'Notes', 'Owner', 'Tag']);
    const fields: CanonicalField[] = ['mdn_last4', 'plan_name', 'plan_base_cents', 'data_used_gb'];
    for (const f of fields) {
      expect(mapping[f] ?? null).toBeNull();
    }
  });

  it('does not reuse a header across two canonical fields', () => {
    // "Plan" is the only column candidate; auto-mapper picks it for the
    // narrower plan_base_cents heuristic? Actually plan_base prefers MRC-like
    // text, so here it should land on plan_name only.
    const headers = ['Wireless Number', 'Plan'];
    const mapping = autoMap(headers);
    expect(mapping.plan_name).toBe('Plan');
    // plan_base_cents shouldn't grab "Plan" too.
    expect(mapping.plan_base_cents ?? null).toBeNull();
  });
});

describe('extractLast4', () => {
  it('returns null for null / undefined / blank', () => {
    expect(extractLast4(null)).toBeNull();
    expect(extractLast4(undefined)).toBeNull();
    expect(extractLast4('')).toBeNull();
    expect(extractLast4('   ')).toBeNull();
  });

  it('returns null when fewer than 4 digits are present', () => {
    expect(extractLast4('ext 12')).toBeNull();
    expect(extractLast4('no digits here')).toBeNull();
  });

  it('extracts last 4 from common phone formats', () => {
    expect(extractLast4('(555) 867-5309')).toBe('5309');
    expect(extractLast4('+1-555-867-5309')).toBe('5309');
    expect(extractLast4('5558675309')).toBe('5309');
    expect(extractLast4('555.867.5309')).toBe('5309');
    expect(extractLast4('555 867 5309')).toBe('5309');
  });

  it('handles account-number-like inputs', () => {
    expect(extractLast4('Account # 123456789')).toBe('6789');
    expect(extractLast4('BAN-0987654321')).toBe('4321');
  });
});

describe('parseMoneyToCents', () => {
  it('parses common positive formats', () => {
    expect(parseMoneyToCents('$1,234.56')).toBe(123_456);
    expect(parseMoneyToCents('1234.56')).toBe(123_456);
    expect(parseMoneyToCents('1,234')).toBe(123_400);
    expect(parseMoneyToCents('1234')).toBe(123_400);
    expect(parseMoneyToCents('$0.99')).toBe(99);
    expect(parseMoneyToCents('+$45.00')).toBe(4_500);
  });

  it('parses accounting and explicit negatives', () => {
    expect(parseMoneyToCents('-12.34')).toBe(-1_234);
    expect(parseMoneyToCents('($12.34)')).toBe(-1_234);
    expect(parseMoneyToCents('-$1,000.00')).toBe(-100_000);
  });

  it('returns null on unparseable / blank', () => {
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents('N/A')).toBeNull();
    expect(parseMoneyToCents('twelve dollars')).toBeNull();
    expect(parseMoneyToCents('12.34.56')).toBeNull();
  });
});

describe('parseGigabytes', () => {
  it('handles GB / MB / KB suffixes', () => {
    expect(parseGigabytes('12.5 GB')).toBeCloseTo(12.5);
    expect(parseGigabytes('500 MB')).toBeCloseTo(500 / 1024);
    expect(parseGigabytes('1024 KB')).toBeCloseTo(1 / 1024);
  });

  it('defaults to GB when no suffix', () => {
    expect(parseGigabytes('5')).toBe(5);
    expect(parseGigabytes('1,024')).toBe(1024);
  });

  it('returns null on blank / unparseable', () => {
    expect(parseGigabytes('')).toBeNull();
    expect(parseGigabytes(null)).toBeNull();
    expect(parseGigabytes('lots')).toBeNull();
  });
});

describe('parseNonNegInt', () => {
  it('strips commas and parses integers', () => {
    expect(parseNonNegInt('1,234')).toBe(1234);
    expect(parseNonNegInt('0')).toBe(0);
  });
  it('rejects floats and blanks', () => {
    expect(parseNonNegInt('')).toBeNull();
    expect(parseNonNegInt('12.5')).toBeNull();
    expect(parseNonNegInt('-5')).toBeNull();
  });
});

describe('parseBoolish', () => {
  it('returns true for affirmative variants', () => {
    expect(parseBoolish('yes')).toBe(true);
    expect(parseBoolish('YES')).toBe(true);
    expect(parseBoolish('Y')).toBe(true);
    expect(parseBoolish('true')).toBe(true);
    expect(parseBoolish('1')).toBe(true);
    expect(parseBoolish('Suspended')).toBe(true);
    expect(parseBoolish('Inactive')).toBe(true);
  });
  it('returns false for negative / blank / unknown', () => {
    expect(parseBoolish('')).toBe(false);
    expect(parseBoolish(null)).toBe(false);
    expect(parseBoolish('no')).toBe(false);
    expect(parseBoolish('Active')).toBe(false);
    expect(parseBoolish('something random')).toBe(false);
  });
});
