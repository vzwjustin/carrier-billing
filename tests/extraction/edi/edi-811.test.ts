import { describe, expect, it } from 'vitest';

import { parseEdi811 } from '@/extraction/edi/edi-811';
import { EdiParseError } from '@/extraction/edi/parser';

// Reusable ISA envelope (106 chars). Standard delimiters * : ~.
const ISA =
  'ISA*00*          *00*          *ZZ*VZW            *ZZ*ACMECORP       *260509*0930*U*00501*000000001*0*P*:~';
const GS = 'GS*BL*VZW*ACMECORP*20260509*0930*1*X*005010~';
const GE = 'GE*1*1~';
const IEA = 'IEA*1*000000001~';

/**
 * Build a Verizon-flavored 811 with one account containing two service points.
 * Hand-rolled to spec — not from any real carrier file.
 */
const VALID_811 = [
  ISA,
  GS,
  // Transaction set
  'ST*811*0001~',
  'BIG*20260430*INV-0001~',
  'N1*VN*Verizon Wireless~',
  'N1*BT*Acme Corp~',
  'DTM*150*20260401~',
  'DTM*151*20260430~',
  // Account hierarchy
  'HL*1**BL~',
  'HL*2*1*AC~',
  'REF*AN*987654321~',
  // Account-level taxes — federal (TXI*FT*5.00) + state (TXI*ST*3.50)
  // X12 N2: integer is implicit cents → "500" = $5.00 = 500 cents.
  'TXI*FT*500~',
  'TXI*ST*350~',
  // First line: base plan $55 + protection $15 = $70 total
  'HL*3*2*SP~',
  'REF*MN*5551234567~',
  'IT1*1*1*EA*55.00***UN*plan~',
  'PID*F**08**Business Unlimited Pro 2.0~',
  'IT1*2*1*EA*15.00***UN*protection~',
  'PID*F**08**Total Mobile Protection~',
  // Second line: qty=2 of $45 = $90 plus a zero-value comp item
  'HL*4*2*SP~',
  'REF*MN*5559998888~',
  'IT1*1*2*EA*45.00***UN*plan~',
  'PID*F**08**Business Unlimited Plus 2.0~',
  'PID*F**08**iPhone 16 Pro~',
  'IT1*2*1*EA*0.00***UN*comp~',
  // Total = 70 + 90 + 8.50 tax = $168.50 = 16850 cents
  'TDS*16850~',
  'CTT*2~',
  'SE*22*0001~',
  GE,
  IEA,
].join('');

describe('parseEdi811 — happy path', () => {
  const result = parseEdi811(VALID_811);

  it('infers Verizon from the N1*VN segment', () => {
    expect(result.detectedCarrier).toBe('verizon');
    expect(result.bill.carrier).toBe('verizon');
  });

  it('extracts the billing period from DTM 150/151', () => {
    expect(result.bill.billing_period_start).toBe('2026-04-01');
    expect(result.bill.billing_period_end).toBe('2026-04-30');
  });

  it('reads the invoice total from TDS01 as implicit-cents', () => {
    expect(result.bill.total_charges_cents).toBe(16850);
  });

  it('sums TXI segments into account taxes_fees_cents', () => {
    // 500 + 350 = 850 cents
    expect(result.bill.accounts[0]?.taxes_fees_cents).toBe(850);
  });

  it('returns one account with two lines', () => {
    expect(result.bill.accounts).toHaveLength(1);
    expect(result.bill.accounts[0]?.lines).toHaveLength(2);
  });

  it('extracts last-4 of each MDN', () => {
    const mdns = result.bill.accounts[0]?.lines.map((l) => l.mdn_last4);
    expect(mdns).toEqual(['4567', '8888']);
  });

  it('extracts last-4 of the account number from REF*AN', () => {
    expect(result.bill.accounts[0]?.account_number_last4).toBe('4321');
  });

  it('parses plan name from PID free-form description', () => {
    const plans = result.bill.accounts[0]?.lines.map((l) => l.plan_name);
    expect(plans).toEqual([
      'Business Unlimited Pro 2.0',
      'Business Unlimited Plus 2.0',
    ]);
  });

  it('parses device when a separate PID looks like a phone model', () => {
    expect(result.bill.accounts[0]?.lines[1]?.device).toBe('iPhone 16 Pro');
  });

  it('sums multiple IT1 segments per service point (base + features)', () => {
    // line[0]: $55 plan + $15 protection = $70 = 7000 cents
    expect(result.bill.accounts[0]?.lines[0]?.plan_base_cents).toBe(7000);
  });

  it('multiplies IT1 unit price by quantity (IT1.02)', () => {
    // line[1]: 2 * $45 + $0 comp = 9000 cents
    expect(result.bill.accounts[0]?.lines[1]?.plan_base_cents).toBe(9000);
  });

  it('account total reflects sum of line plan_base_cents (incl. zero-value)', () => {
    // 7000 + 9000 = 16000. Tax sits separately in taxes_fees_cents.
    expect(result.bill.accounts[0]?.total_charges_cents).toBe(16000);
  });

  it('marks notes with edi 811 source', () => {
    expect(result.bill.notes.join(' ')).toContain('EDI 811');
  });
});

describe('parseEdi811 — error paths', () => {
  it('throws EdiParseError when the transaction set is not 811', () => {
    const not811 = VALID_811.replace('ST*811*0001~', 'ST*810*0001~');
    expect(() => parseEdi811(not811)).toThrowError(EdiParseError);
  });

  it('throws EdiParseError when no DTM or BIG date is parseable', () => {
    const noDates = VALID_811
      .replace('BIG*20260430*INV-0001~', 'BIG*XXXXXX*INV-0001~')
      .replace('DTM*150*20260401~', '')
      .replace('DTM*151*20260430~', '');
    expect(() => parseEdi811(noDates)).toThrowError(EdiParseError);
  });

  it('throws EdiParseError when TDS01 is missing', () => {
    const noTotal = VALID_811.replace('TDS*16850~', '');
    expect(() => parseEdi811(noTotal)).toThrowError(EdiParseError);
  });

  it('throws EdiParseError when no HL accounts/lines exist', () => {
    const noHl = VALID_811
      .replace('HL*1**BL~', '')
      .replace('HL*2*1*AC~', '')
      .replace('REF*AN*987654321~', '')
      .replace('HL*3*2*SP~', '')
      .replace('HL*4*2*SP~', '');
    expect(() => parseEdi811(noHl)).toThrowError(EdiParseError);
  });

  it('handles missing DTM 151 by reusing the start date', () => {
    const oneSidedDtm = VALID_811.replace('DTM*151*20260430~', '');
    const r = parseEdi811(oneSidedDtm);
    // Falls back to BIG date for end (20260430), start stays from DTM 150.
    expect(r.bill.billing_period_start).toBe('2026-04-01');
    expect(r.bill.billing_period_end).toBe('2026-04-30');
  });

  it('synthesizes an account when only line-level HLs exist', () => {
    // Drop the account-level HL but keep the SP HLs.
    const noAccountHl = VALID_811
      .replace('HL*2*1*AC~', '')
      .replace('REF*AN*987654321~', '');
    const r = parseEdi811(noAccountHl);
    expect(r.bill.accounts).toHaveLength(1);
    expect(r.bill.accounts[0]?.account_number_last4).toBeNull();
    expect(r.bill.accounts[0]?.lines).toHaveLength(2);
  });
});

describe('parseEdi811 — carrier detection', () => {
  it('detects AT&T from N1*VN*AT&T Mobility', () => {
    const att = VALID_811.replace(
      'N1*VN*Verizon Wireless~',
      'N1*VN*AT&T Mobility~',
    );
    expect(parseEdi811(att).detectedCarrier).toBe('att');
  });

  it('detects T-Mobile from N1*VN*T-Mobile USA', () => {
    const tmo = VALID_811.replace(
      'N1*VN*Verizon Wireless~',
      'N1*VN*T-Mobile USA~',
    );
    expect(parseEdi811(tmo).detectedCarrier).toBe('tmobile');
  });

  it('falls back to unknown for an unrecognized vendor name', () => {
    const unknown = VALID_811.replace(
      'N1*VN*Verizon Wireless~',
      'N1*VN*Some Regional Carrier~',
    );
    expect(parseEdi811(unknown).detectedCarrier).toBe('unknown');
  });
});
