import { describe, expect, it } from 'vitest';

import { autoMap, type ColumnMapping } from '@/extraction/csv/mapping';
import { MAX_CELLS, parseCsvRows, parseCsvToBill } from '@/extraction/csv/parse';

describe('parseCsvRows (RFC 4180 reader)', () => {
  it('handles simple unquoted rows', () => {
    const rows = parseCsvRows('a,b,c\n1,2,3\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF terminators', () => {
    const rows = parseCsvRows('a,b\r\n1,2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quoted commas and escaped quotes', () => {
    const rows = parseCsvRows('name,note\n"Smith, John","She said ""hi"""\n');
    expect(rows).toEqual([
      ['name', 'note'],
      ['Smith, John', 'She said "hi"'],
    ]);
  });

  it('handles embedded newlines in quoted cells', () => {
    const rows = parseCsvRows('a,b\n"line1\nline2",2\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['line1\nline2', '2'],
    ]);
  });

  it('strips a UTF-8 BOM', () => {
    const rows = parseCsvRows('﻿a,b\n1,2\n');
    expect(rows[0]).toEqual(['a', 'b']);
  });

  it('throws when cell count exceeds MAX_CELLS', () => {
    // 5 columns; need rows > MAX_CELLS / 5.
    const header = Array.from({ length: 5 }, (_, i) => `c${i}`).join(',');
    const dataRow = '0,0,0,0,0';
    const rowCount = Math.ceil(MAX_CELLS / 5) + 10;
    const text = [header, ...Array.from({ length: rowCount }, () => dataRow)].join('\n');
    expect(() => parseCsvRows(text)).toThrow(/maximum cell count/);
  });
});

// ---------------------------------------------------------------------------
// parseCsvToBill — schema-validated output
// ---------------------------------------------------------------------------

describe('parseCsvToBill', () => {
  it('rejects an empty CSV', () => {
    const res = parseCsvToBill('', {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/empty/i);
  });

  it('rejects a header-only CSV', () => {
    const res = parseCsvToBill('mdn,plan\n', {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/header.*data|data row/i);
  });

  it('parses a one-account, three-line CSV', () => {
    const csv =
      'Wireless Number,User Name,Plan,Monthly Plan Charge,Data Usage (GB),Account Number\n' +
      '(555) 100-1111,Alice,Business Pro,$45.00,12.5,1234567890\n' +
      '(555) 100-2222,Bob,Business Pro,$45.00,3.2,1234567890\n' +
      '(555) 100-3333,Carol,Business Lite,$30.00,1.1,1234567890\n';
    const headers = [
      'Wireless Number',
      'User Name',
      'Plan',
      'Monthly Plan Charge',
      'Data Usage (GB)',
      'Account Number',
    ];
    const mapping = autoMap(headers);
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const bill = res.bill;
    expect(bill.accounts).toHaveLength(1);
    const account = bill.accounts[0]!;
    expect(account.account_number_last4).toBe('7890');
    expect(account.lines).toHaveLength(3);
    const alice = account.lines[0]!;
    expect(alice.mdn_last4).toBe('1111');
    expect(alice.plan_name).toBe('Business Pro');
    expect(alice.plan_base_cents).toBe(4_500);
    expect(alice.data_used_gb).toBe(12.5);
    // Total = 45 + 45 + 30 = 120
    expect(account.total_charges_cents).toBe(12_000);
    expect(bill.total_charges_cents).toBe(12_000);
  });

  it('groups a three-account CSV by account_number_last4', () => {
    const csv =
      'Wireless Number,Plan,Monthly Plan Charge,Account Number\n' +
      '5551111111,Plan A,$40.00,1111111111\n' +
      '5552222222,Plan A,$40.00,1111111111\n' +
      '5553333333,Plan B,$60.00,2222222222\n' +
      '5554444444,Plan B,$60.00,2222222222\n' +
      '5555555555,Plan C,$80.00,3333333333\n';
    const mapping = autoMap([
      'Wireless Number',
      'Plan',
      'Monthly Plan Charge',
      'Account Number',
    ]);
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bill.accounts).toHaveLength(3);
    const totals = res.bill.accounts
      .map((a) => a.total_charges_cents)
      .sort((a, b) => a - b);
    expect(totals).toEqual([8_000, 12_000, 8_000].sort((a, b) => a - b));
  });

  it('produces one account with null number when account column is blank', () => {
    const csv =
      'Wireless Number,Plan,Monthly Plan Charge\n' +
      '5551111111,Plan A,$40.00\n' +
      '5552222222,Plan B,$60.00\n';
    const mapping: ColumnMapping = {
      mdn_last4: 'Wireless Number',
      plan_name: 'Plan',
      plan_base_cents: 'Monthly Plan Charge',
    };
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bill.accounts).toHaveLength(1);
    expect(res.bill.accounts[0]!.account_number_last4).toBeNull();
    expect(res.bill.accounts[0]!.lines).toHaveLength(2);
  });

  it('tolerates malformed money cells by nulling them out', () => {
    const csv =
      'Wireless Number,Plan,Monthly Plan Charge\n' +
      '5551111111,Plan A,not-a-number\n' +
      '5552222222,Plan A,$30.00\n';
    const mapping: ColumnMapping = {
      mdn_last4: 'Wireless Number',
      plan_name: 'Plan',
      plan_base_cents: 'Monthly Plan Charge',
    };
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lines = res.bill.accounts[0]!.lines;
    expect(lines[0]!.plan_base_cents).toBeNull();
    expect(lines[1]!.plan_base_cents).toBe(3_000);
    expect(res.bill.accounts[0]!.total_charges_cents).toBe(3_000);
  });

  it('derives last-4 from a variety of phone formats', () => {
    const csv =
      'Wireless Number,Plan,Monthly Plan Charge\n' +
      '(555) 100-1111,P,$10\n' +
      '+1-555-100-2222,P,$10\n' +
      '555.100.3333,P,$10\n' +
      '5551004444,P,$10\n' +
      '555 100 5555,P,$10\n';
    const mapping: ColumnMapping = {
      mdn_last4: 'Wireless Number',
      plan_name: 'Plan',
      plan_base_cents: 'Monthly Plan Charge',
    };
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const got = res.bill.accounts[0]!.lines.map((l) => l.mdn_last4);
    expect(got).toEqual(['1111', '2222', '3333', '4444', '5555']);
  });

  it('caps total cell count', () => {
    const header = 'a,b\n';
    // Build a CSV with enough rows that 2 * rowCount > MAX_CELLS.
    const rowCount = Math.ceil(MAX_CELLS / 2) + 10;
    const dataRows = Array.from({ length: rowCount }, () => '1,2').join('\n');
    const text = header + dataRows + '\n';
    const res = parseCsvToBill(text, { mdn_last4: 'a' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/maximum cell count|parse/i);
  });

  it('accepts a CSV with no data and reports a clean error', () => {
    const csv = 'Wireless Number,Plan\n,\n,\n';
    // All-blank rows are filtered, so the resulting dataRows array is empty.
    const res = parseCsvToBill(csv, { mdn_last4: 'Wireless Number' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no non-blank data/i);
  });

  it('redacts/clamps a too-long user_label', () => {
    const longLabel = 'A'.repeat(200);
    const csv = `Wireless Number,User Name,Plan,Monthly Plan Charge\n5551111111,${longLabel},Plan A,$10.00\n`;
    const mapping: ColumnMapping = {
      mdn_last4: 'Wireless Number',
      user_label: 'User Name',
      plan_name: 'Plan',
      plan_base_cents: 'Monthly Plan Charge',
    };
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const labelRaw = res.bill.accounts[0]!.lines[0]!.user_label;
    // Either truncated to 40 chars or null/redacted by schema name-scrubber.
    if (labelRaw !== null) {
      expect(labelRaw.length).toBeLessThanOrEqual(40);
    }
  });

  it('nulls likely subscriber names from mapped user_label cells', () => {
    const csv =
      'Wireless Number,User Name,Plan,Monthly Plan Charge\n' +
      '5551111111,Alice,Plan A,$10.00\n' +
      '5552222222,JANE DOE,Plan A,$10.00\n' +
      '5553333333,John Smith,Plan A,$10.00\n';
    const mapping: ColumnMapping = {
      mdn_last4: 'Wireless Number',
      user_label: 'User Name',
      plan_name: 'Plan',
      plan_base_cents: 'Monthly Plan Charge',
    };
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const labels = res.bill.accounts[0]!.lines.map((line) => line.user_label);
    expect(labels).toEqual([null, null, null]);
  });

  it('preserves safe non-human user_label cells', () => {
    const csv =
      'Wireless Number,User Name,Plan,Monthly Plan Charge\n' +
      '5551111111,Department,Plan A,$10.00\n' +
      '5552222222,Store,Plan A,$10.00\n' +
      '5553333333,Line 12,Plan A,$10.00\n' +
      '5554444444,Tablet,Plan A,$10.00\n' +
      '5555555555,Router,Plan A,$10.00\n' +
      '5556666666,CC-1001,Plan A,$10.00\n';
    const mapping: ColumnMapping = {
      mdn_last4: 'Wireless Number',
      user_label: 'User Name',
      plan_name: 'Plan',
      plan_base_cents: 'Monthly Plan Charge',
    };
    const res = parseCsvToBill(csv, mapping);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const labels = res.bill.accounts[0]!.lines.map((line) => line.user_label);
    expect(labels).toEqual([
      'Department',
      'Store',
      'Line 12',
      'Tablet',
      'Router',
      'CC-1001',
    ]);
  });
});
