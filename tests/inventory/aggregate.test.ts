import { describe, expect, it } from 'vitest';

import {
  aggregateInventory,
  buildLineKey,
  classifyDevice,
  lineHistory,
  parseLineKey,
  summarizeInventory,
  type InventoryLineInput,
} from '@/lib/inventory/aggregate';

function line(over: Partial<InventoryLineInput>): InventoryLineInput {
  return {
    audit_id: 'audit-1',
    account_number_masked: '1234',
    mdn_masked: '5678',
    device_description: 'Apple iPhone 13',
    plan_name: 'Business Unlimited',
    plan_base_cents: 4500,
    is_suspended: false,
    carrier: 'verizon',
    billing_period_end: '2025-04-30',
    completed_at: '2025-05-02T10:00:00Z',
    ...over,
  };
}

describe('classifyDevice', () => {
  it('classifies phones', () => {
    expect(classifyDevice('Apple iPhone 13 Pro')).toBe('phone');
    expect(classifyDevice('Google Pixel 8')).toBe('phone');
    expect(classifyDevice('Samsung Galaxy S23')).toBe('phone');
  });
  it('classifies tablets', () => {
    expect(classifyDevice('Apple iPad Pro 12.9')).toBe('tablet');
    expect(classifyDevice('Samsung Galaxy Tab S9')).toBe('tablet');
  });
  it('classifies watches', () => {
    expect(classifyDevice('Apple Watch Series 9')).toBe('watch');
    expect(classifyDevice('Samsung Galaxy Watch 6')).toBe('watch');
  });
  it('classifies hotspots', () => {
    expect(classifyDevice('Verizon Jetpack MiFi 8800L')).toBe('hotspot');
    expect(classifyDevice('Inseego 5G MiFi M2000')).toBe('hotspot');
  });
  it('classifies routers', () => {
    expect(classifyDevice('Cradlepoint W1850 5G Adapter')).toBe('router');
    expect(classifyDevice('Verizon 5G Router')).toBe('router');
  });
  it('returns other for null/empty/unknown', () => {
    expect(classifyDevice(null)).toBe('other');
    expect(classifyDevice('')).toBe('other');
    expect(classifyDevice('Generic IoT Sensor')).toBe('other');
  });
  it('prefers watch over phone when both match', () => {
    expect(classifyDevice('Apple Watch (paired with iPhone)')).toBe('watch');
  });
});

describe('buildLineKey / parseLineKey', () => {
  it('round-trips known account+mdn', () => {
    const key = buildLineKey('1234', '5678');
    expect(key).toBe('1234/5678');
    expect(parseLineKey(key)).toEqual({ accountLast4: '1234', mdnLast4: '5678' });
  });
  it('uses sentinels for nulls', () => {
    expect(buildLineKey(null, null)).toBe('no-account/no-mdn');
    expect(buildLineKey('1234', null)).toBe('1234/no-mdn');
    expect(buildLineKey(null, '5678')).toBe('no-account/5678');
  });
  it('rejects malformed keys', () => {
    expect(parseLineKey('no-slash')).toBeNull();
    expect(parseLineKey('/trailing')).toBeNull();
    expect(parseLineKey('leading/')).toBeNull();
  });
});

describe('aggregateInventory', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateInventory([])).toEqual([]);
  });

  it('produces one row for a single line on one audit', () => {
    const rows = aggregateInventory([line({})]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('expected one row');
    expect(row.lineKey).toBe('1234/5678');
    expect(row.accountLast4).toBe('1234');
    expect(row.mdnLast4).toBe('5678');
    expect(row.device).toBe('Apple iPhone 13');
    expect(row.planName).toBe('Business Unlimited');
    expect(row.planBaseCents).toBe(4500);
    expect(row.carrier).toBe('verizon');
    expect(row.lastSeen).toBe('2025-04-30');
    expect(row.status).toBe('active');
    expect(row.auditCount).toBe(1);
    expect(row.deviceType).toBe('phone');
  });

  it('rolls up a line across multiple audits, picking most-recent metadata', () => {
    const rows = aggregateInventory([
      line({
        audit_id: 'a1',
        billing_period_end: '2025-01-31',
        completed_at: '2025-02-01T00:00:00Z',
        plan_name: 'Old Plan',
        plan_base_cents: 5000,
        device_description: 'iPhone 12',
      }),
      line({
        audit_id: 'a2',
        billing_period_end: '2025-03-31',
        completed_at: '2025-04-01T00:00:00Z',
        plan_name: 'Mid Plan',
        plan_base_cents: 4700,
        device_description: 'iPhone 12',
      }),
      line({
        audit_id: 'a3',
        billing_period_end: '2025-05-31',
        completed_at: '2025-06-01T00:00:00Z',
        plan_name: 'New Plan',
        plan_base_cents: 4500,
        device_description: 'iPhone 13',
      }),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('expected row');
    expect(row.auditCount).toBe(3);
    expect(row.lastSeen).toBe('2025-05-31');
    expect(row.planName).toBe('New Plan');
    expect(row.planBaseCents).toBe(4500);
    expect(row.device).toBe('iPhone 13');
  });

  it('counts distinct audits even if the same line appears twice on one audit', () => {
    const rows = aggregateInventory([
      line({ audit_id: 'a1' }),
      line({ audit_id: 'a1' }),
      line({ audit_id: 'a2' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.auditCount).toBe(2);
  });

  it('separates rows by account when MDN matches but account differs', () => {
    const rows = aggregateInventory([
      line({ account_number_masked: '1111', mdn_masked: '5555' }),
      line({ account_number_masked: '2222', mdn_masked: '5555' }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('separates rows by MDN when account matches but MDN differs', () => {
    const rows = aggregateInventory([
      line({ mdn_masked: '1111' }),
      line({ mdn_masked: '2222' }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('treats missing MDN as a distinct sentinel bucket per account', () => {
    const rows = aggregateInventory([
      line({ mdn_masked: null, audit_id: 'a1' }),
      line({ mdn_masked: null, audit_id: 'a2' }),
      line({ mdn_masked: '5678', audit_id: 'a3' }),
    ]);
    expect(rows).toHaveLength(2);
    const noMdn = rows.find((r) => r.mdnLast4 === 'no-mdn');
    expect(noMdn).toBeDefined();
    expect(noMdn?.auditCount).toBe(2);
  });

  it('classifies status from most-recent audit (suspended)', () => {
    const rows = aggregateInventory([
      line({
        audit_id: 'a1',
        billing_period_end: '2025-01-31',
        is_suspended: false,
      }),
      line({
        audit_id: 'a2',
        billing_period_end: '2025-05-31',
        is_suspended: true,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('suspended');
  });

  it('classifies status from most-recent audit (active even if older was suspended)', () => {
    const rows = aggregateInventory([
      line({
        audit_id: 'a1',
        billing_period_end: '2025-01-31',
        is_suspended: true,
      }),
      line({
        audit_id: 'a2',
        billing_period_end: '2025-05-31',
        is_suspended: false,
      }),
    ]);
    expect(rows[0]?.status).toBe('active');
  });

  it('treats null is_suspended as active', () => {
    const rows = aggregateInventory([line({ is_suspended: null })]);
    expect(rows[0]?.status).toBe('active');
  });

  it('classifies device type from device description', () => {
    const rows = aggregateInventory([
      line({ mdn_masked: '0001', device_description: 'iPhone 14' }),
      line({ mdn_masked: '0002', device_description: 'iPad Pro' }),
      line({ mdn_masked: '0003', device_description: 'Apple Watch Series 9' }),
      line({ mdn_masked: '0004', device_description: 'Jetpack MiFi 8800L' }),
      line({ mdn_masked: '0005', device_description: 'Cradlepoint W1850' }),
      line({ mdn_masked: '0006', device_description: 'IoT Sensor' }),
    ]);
    const byMdn = new Map(rows.map((r) => [r.mdnLast4, r.deviceType]));
    expect(byMdn.get('0001')).toBe('phone');
    expect(byMdn.get('0002')).toBe('tablet');
    expect(byMdn.get('0003')).toBe('watch');
    expect(byMdn.get('0004')).toBe('hotspot');
    expect(byMdn.get('0005')).toBe('router');
    expect(byMdn.get('0006')).toBe('other');
  });

  it('falls back to completed_at when billing_period_end is missing', () => {
    const rows = aggregateInventory([
      line({
        audit_id: 'a1',
        billing_period_end: null,
        completed_at: '2025-01-01T00:00:00Z',
        plan_name: 'Old',
      }),
      line({
        audit_id: 'a2',
        billing_period_end: null,
        completed_at: '2025-05-01T00:00:00Z',
        plan_name: 'New',
      }),
    ]);
    expect(rows[0]?.planName).toBe('New');
  });

  it('default-sorts rows most-recent first', () => {
    const rows = aggregateInventory([
      line({ mdn_masked: '1111', billing_period_end: '2025-01-31' }),
      line({ mdn_masked: '2222', billing_period_end: '2025-05-31' }),
      line({ mdn_masked: '3333', billing_period_end: '2025-03-31' }),
    ]);
    expect(rows.map((r) => r.mdnLast4)).toEqual(['2222', '3333', '1111']);
  });
});

describe('summarizeInventory', () => {
  it('counts everything to zero on empty input', () => {
    expect(summarizeInventory([])).toEqual({
      totalLines: 0,
      active: 0,
      suspended: 0,
      uniqueDevices: 0,
    });
  });

  it('aggregates totals, statuses, and unique device strings', () => {
    const rows = aggregateInventory([
      line({ mdn_masked: '1111', device_description: 'iPhone 13', is_suspended: false }),
      line({ mdn_masked: '2222', device_description: 'iPhone 13', is_suspended: true }),
      line({ mdn_masked: '3333', device_description: 'iPad Pro', is_suspended: false }),
    ]);
    const stats = summarizeInventory(rows);
    expect(stats.totalLines).toBe(3);
    expect(stats.active).toBe(2);
    expect(stats.suspended).toBe(1);
    expect(stats.uniqueDevices).toBe(2); // iPhone 13 + iPad Pro
  });
});

describe('lineHistory', () => {
  it('returns entries most-recent first', () => {
    const history = lineHistory([
      line({ audit_id: 'a1', billing_period_end: '2025-01-31' }),
      line({ audit_id: 'a2', billing_period_end: '2025-05-31' }),
      line({ audit_id: 'a3', billing_period_end: '2025-03-31' }),
    ]);
    expect(history.map((h) => h.auditId)).toEqual(['a2', 'a3', 'a1']);
  });

  it('preserves per-audit plan base for sparkline-style display', () => {
    const history = lineHistory([
      line({ audit_id: 'a1', billing_period_end: '2025-01-31', plan_base_cents: 5000 }),
      line({ audit_id: 'a2', billing_period_end: '2025-05-31', plan_base_cents: 4500 }),
    ]);
    expect(history.map((h) => h.planBaseCents)).toEqual([4500, 5000]);
  });
});
