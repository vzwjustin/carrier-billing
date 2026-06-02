import { describe, it, expect, vi } from 'vitest';
import {
  runEdi811Pipeline,
  Edi811PipelineError,
  isLikelyEdi811Buffer,
  MAX_EDI_BYTES,
} from '@/extraction/edi811/pipeline';
import { MAX_EDI_SEGMENTS } from '@/extraction/edi811/parser';
import { ExtractedBillSchema } from '@/extraction/schema';
import { buildIsa, buildGs, buildInterchange, buildSac } from './fixtures/build';

function bufferOf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

describe('runEdi811Pipeline — Verizon fixture', () => {
  const VERIZON_BODY = [
    'ST*811*0001~',
    'BIG*20260401*INV-12345*20260301*PO-123~',
    'N1*RE*Verizon Wireless~',
    'N1*BT*ACME CORP~',
    'DTM*150*20260301~',
    'DTM*151*20260331~',
    // Account loop
    'HL*1**A~',
    'REF*9V*1234567890~',
    // Subscriber #1
    'HL*2*1*B~',
    'REF*MN*5551234567~',
    'PID*F****iPhone 15~',
    'IT1**1*EA*60.00**VP*Business Unlimited Pro 2.0~',
    buildSac({ indicator: 'A', code: 'F050', amount: '10.00', description: 'Q1 promo credit' }),
    buildSac({ indicator: 'C', code: 'B660', amount: '15.00', description: 'Total Mobile Protection' }),
    'QTY*DG*22~',
    // Subscriber #2
    'HL*3*1*B~',
    'REF*MN*5559876543~',
    'PID*F****iPhone 14~',
    'IT1**1*EA*45.00**VP*Business Unlimited Plus 2.0~',
    buildSac({ indicator: 'C', code: 'F305', amount: '6.00', description: 'Verizon Cloud' }),
    'TXI*ST*5.50~',
    'TDS*13150~',
    'CTT*2~',
    'SE*22*0001~',
  ].join('');

  const interchange = buildInterchange({
    isa: buildIsa({ senderId: 'VZW', receiverId: 'ACME' }),
    gs: buildGs('VZWBILLING'),
    body: VERIZON_BODY,
  });

  it('produces a schema-valid ExtractedBill', async () => {
    const result = await runEdi811Pipeline({ buffer: bufferOf(interchange) });
    expect(result.detectedCarrier).toBe('verizon');
    expect(() => ExtractedBillSchema.parse(result.bill)).not.toThrow();
  });

  it('detects raw, BOM-prefixed, and whitespace-prefixed EDI buffers', () => {
    expect(isLikelyEdi811Buffer(bufferOf(interchange))).toBe(true);
    expect(isLikelyEdi811Buffer(bufferOf(`\uFEFF${interchange}`))).toBe(true);
    expect(isLikelyEdi811Buffer(bufferOf(` \r\n\t${interchange}`))).toBe(true);
  });

  it('does not classify PDFs or prose starting with ISA letters as EDI', () => {
    expect(isLikelyEdi811Buffer(Buffer.from('%PDF-1.7\n', 'utf8'))).toBe(false);
    expect(isLikelyEdi811Buffer(Buffer.from('  ISABELLA is not an envelope', 'utf8'))).toBe(false);
  });

  it('runs the EDI pipeline for BOM-prefixed and whitespace-prefixed interchanges', async () => {
    const bomResult = await runEdi811Pipeline({
      buffer: bufferOf(`\uFEFF${interchange}`),
    });
    const whitespaceResult = await runEdi811Pipeline({
      buffer: bufferOf(` \r\n\t${interchange}`),
    });

    expect(bomResult.detectedCarrier).toBe('verizon');
    expect(whitespaceResult.detectedCarrier).toBe('verizon');
  });

  it('captures billing period from DTM 150/151', async () => {
    const { bill } = await runEdi811Pipeline({ buffer: bufferOf(interchange) });
    expect(bill.billing_period_start).toBe('2026-03-01');
    expect(bill.billing_period_end).toBe('2026-03-31');
  });

  it('produces one account with two lines and the expected MDN/device fields', async () => {
    const { bill } = await runEdi811Pipeline({ buffer: bufferOf(interchange) });
    expect(bill.accounts).toHaveLength(1);
    const account = bill.accounts[0]!;
    expect(account.account_number_last4).toBe('7890');
    expect(account.lines).toHaveLength(2);

    const [line1, line2] = account.lines;
    expect(line1!.mdn_last4).toBe('4567');
    expect(line1!.device).toBe('iPhone 15');
    expect(line1!.plan_name).toBe('Business Unlimited Pro 2.0');
    expect(line1!.plan_base_cents).toBe(6_000);
    expect(line1!.data_used_gb).toBe(22);

    expect(line2!.mdn_last4).toBe('6543');
    expect(line2!.plan_name).toBe('Business Unlimited Plus 2.0');
    expect(line2!.plan_base_cents).toBe(4_500);
  });

  it('records SAC charges as features (negative-sign credits enforced)', async () => {
    const { bill } = await runEdi811Pipeline({ buffer: bufferOf(interchange) });
    const line1 = bill.accounts[0]!.lines[0]!;
    const insurance = line1.features.find((f) => f.category === 'insurance');
    expect(insurance).toBeDefined();
    expect(insurance!.monthly_cents).toBe(1_500);

    const promo = line1.credits[0]!;
    expect(promo.monthly_cents).toBe(-1_000);
    expect(promo.is_promo).toBe(true);
  });

  it('captures the TDS total at the bill level', async () => {
    const { bill } = await runEdi811Pipeline({ buffer: bufferOf(interchange) });
    expect(bill.total_charges_cents).toBe(13_150);
  });
});

describe('runEdi811Pipeline — AT&T fixture', () => {
  const ATT_BODY = [
    'ST*811*0001~',
    'BIG*20260401*INV-AT&T-9*20260301~',
    'N1*RE*AT&T Mobility LLC~',
    'N1*BT*ACME CORP~',
    'DTM*150*20260301~',
    'DTM*151*20260331~',
    'HL*1**A~',
    'REF*9V*9876543210~',
    'HL*2*1*B~',
    'REF*MN*5550001111~',
    'PID*F****Samsung Galaxy S24~',
    'IT1**1*EA*70.00**VP*Business Unlimited Premium~',
    buildSac({ indicator: 'C', code: 'B610', amount: '12.00', description: 'AT&T Mobile Insurance' }),
    buildSac({ indicator: 'C', code: 'F210', amount: '10.00', description: 'International Day Pass' }),
    buildSac({
      indicator: 'C',
      code: 'D830',
      amount: '33.30',
      description: 'Samsung Galaxy S24 Installment',
      remainingPayments: 23,
      totalPayments: 24,
    }),
    'TDS*12530~',
    'CTT*1~',
    'SE*16*0001~',
  ].join('');

  const interchange = buildInterchange({
    isa: buildIsa({ senderId: 'ATT', receiverId: 'ACME' }),
    gs: buildGs('ATTBILLING'),
    body: ATT_BODY,
  });

  it('detects ATT and canonicalizes plan + features', async () => {
    const { bill, detectedCarrier } = await runEdi811Pipeline({
      buffer: bufferOf(interchange),
    });
    expect(detectedCarrier).toBe('att');
    const line = bill.accounts[0]!.lines[0]!;
    expect(line.plan_name).toBe('Business Unlimited Premium');
    expect(line.features.some((f) => f.category === 'insurance')).toBe(true);
    expect(line.features.some((f) => f.category === 'international')).toBe(true);
    // DPP installment captured from SAC D830 (the 7th element in our SAC layout
    // is treated as remaining_payments, the 8th as total_payments).
    expect(line.dpp_installments).toHaveLength(1);
    expect(line.dpp_installments[0]!.monthly_cents).toBe(3_330);
  });
});

describe('runEdi811Pipeline — T-Mobile fixture', () => {
  const TMOBILE_BODY = [
    'ST*811*0001~',
    'BIG*20260401*INV-TMO-7*20260301~',
    'N1*RE*T-Mobile US~',
    'N1*BT*ACME CORP~',
    'DTM*150*20260301~',
    'DTM*151*20260331~',
    'HL*1**A~',
    'REF*9V*5555555555~',
    'HL*2*1*B~',
    'REF*MN*5552223333~',
    'IT1**1*EA*55.00**VP*Business Unlimited Ultimate~',
    buildSac({ indicator: 'C', code: 'B620', amount: '18.00', description: 'Protection 360' }),
    buildSac({ indicator: 'A', code: 'F050', amount: '8.00', description: 'Bill Credit' }),
    'TDS*6500~',
    'CTT*1~',
    'SE*13*0001~',
  ].join('');

  const interchange = buildInterchange({
    isa: buildIsa({ senderId: 'TMUS', receiverId: 'ACME' }),
    gs: buildGs('TMUSBILLING'),
    body: TMOBILE_BODY,
  });

  it('detects T-Mobile and forces is_promo=true on Bill Credit allowances', async () => {
    const { bill, detectedCarrier } = await runEdi811Pipeline({
      buffer: bufferOf(interchange),
    });
    expect(detectedCarrier).toBe('tmobile');
    const line = bill.accounts[0]!.lines[0]!;
    expect(line.plan_name).toBe('Business Unlimited Ultimate');
    expect(line.features.some((f) => f.category === 'insurance')).toBe(true);
    const credit = line.credits[0]!;
    expect(credit.name).toBe('Bill Credit');
    expect(credit.is_promo).toBe(true);
    expect(credit.monthly_cents).toBe(-800);
  });
});

describe('runEdi811Pipeline — failure modes', () => {
  it('throws Edi811PipelineError on garbage input', async () => {
    await expect(
      runEdi811Pipeline({ buffer: Buffer.from('not even close to EDI') }),
    ).rejects.toThrow(Edi811PipelineError);
  });

  it('throws Edi811PipelineError on a truncated ISA header', async () => {
    await expect(
      runEdi811Pipeline({ buffer: Buffer.from('ISA*missing rest of header') }),
    ).rejects.toThrow(Edi811PipelineError);
  });

  // ───────────────────────────────────────────────────────────────────────
  // (C6) Size cap and segment cap. Both bounds are intended to fail the
  // ingest cleanly before the worker burns memory on a hostile payload.
  // ───────────────────────────────────────────────────────────────────────
  it('exposes the byte cap as a 5 MB constant', () => {
    expect(MAX_EDI_BYTES).toBe(5 * 1024 * 1024);
  });

  it('exposes the segment cap as 50,000', () => {
    expect(MAX_EDI_SEGMENTS).toBe(50_000);
  });

  it('rejects buffers larger than MAX_EDI_BYTES at the decode step', async () => {
    const oversized = Buffer.alloc(MAX_EDI_BYTES + 1);
    let caught: unknown = null;
    try {
      await runEdi811Pipeline({ buffer: oversized });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Edi811PipelineError);
    const e = caught as Edi811PipelineError;
    expect(e.step).toBe('decode');
    expect(e.message).toMatch(/byte limit/i);
    expect(e.message).toContain(String(oversized.byteLength));
  });

  it('rejects an interchange whose segment count exceeds MAX_EDI_SEGMENTS', async () => {
    // Build an envelope with too many cheap N1 segments. Each segment is
    // ~9 bytes ("N1*RE*X~"), and we need >50k. Total payload is bounded
    // (~480 KB) so the byte cap won't fire first.
    const isa = buildIsa({ senderId: 'VZW', receiverId: 'ACME' });
    const gs = buildGs('VZWBILLING');
    const stuffer = Array.from(
      { length: MAX_EDI_SEGMENTS + 5 },
      () => 'N1*RE*X~',
    ).join('');
    const body = `ST*811*0001~${stuffer}SE*${MAX_EDI_SEGMENTS + 7}*0001~`;
    const interchange = buildInterchange({ isa, gs, body });

    let caught: unknown = null;
    try {
      await runEdi811Pipeline({ buffer: Buffer.from(interchange, 'utf8') });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Edi811PipelineError);
    const e = caught as Edi811PipelineError;
    expect(e.step).toBe('parse');
    expect(e.message).toMatch(/segments|segment limit|exceeds/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // (M-E4) Non-811 transaction sets must surface as "not a wireless bill"
  // so the downstream isNotAWirelessBill helper can collapse the failure
  // reason into the same friendly label as the LLM path.
  // ───────────────────────────────────────────────────────────────────────
  it('rejects a non-811 transaction set with a "not a wireless bill" message', async () => {
    // ST*810 (invoice) instead of ST*811. Otherwise valid envelope.
    const body = [
      'ST*810*0001~',
      'BIG*20260401*INV-X~',
      'N1*RE*ACME Mobile Co~',
      'CTT*0~',
      'SE*4*0001~',
    ].join('');
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'VZW', receiverId: 'ACME' }),
      gs: buildGs('VZWBILLING'),
      body,
    });
    let caught: unknown = null;
    try {
      await runEdi811Pipeline({ buffer: Buffer.from(interchange, 'utf8') });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Edi811PipelineError);
    const e = caught as Edi811PipelineError;
    expect(e.step).toBe('parse');
    expect(e.message).toMatch(/not a wireless bill/i);
  });

  // ───────────────────────────────────────────────────────────────────────
  // (M-E2) Single-DTM billing-period reconciliation: when only one of
  // start/end is present, anchor the other side off the known one rather
  // than falling back to the invoice date / today and dropping the real
  // datum.
  // ───────────────────────────────────────────────────────────────────────
  it('anchors the missing billing-period side off the present DTM', async () => {
    // Only DTM*150 (period start) is present.
    const body = [
      'ST*811*0001~',
      'BIG*20260401*INV-Y~',
      'N1*RE*ACME Mobile Co~',
      'DTM*150*20260301~',
      'HL*1**A~',
      'REF*9V*1234567890~',
      'HL*2*1*B~',
      'REF*MN*5551234567~',
      'IT1**1*EA*40.00**VP*Generic Plan~',
      'TDS*4000~',
      'SE*10*0001~',
    ].join('');
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'GENERIC', receiverId: 'ACME' }),
      gs: buildGs('GENERICEDI'),
      body,
    });
    const { bill } = await runEdi811Pipeline({
      buffer: Buffer.from(interchange, 'utf8'),
    });
    expect(bill.billing_period_start).toBe('2026-03-01');
    // End anchored 29 days after the known start — never before it.
    expect(bill.billing_period_end >= bill.billing_period_start).toBe(true);
    expect(bill.billing_period_end).toBe('2026-03-30');
  });

  it('anchors the start off a present DTM*151 (period end) when start is missing', async () => {
    const body = [
      'ST*811*0001~',
      'BIG*20260401*INV-Z~',
      'N1*RE*ACME Mobile Co~',
      'DTM*151*20260331~',
      'HL*1**A~',
      'REF*9V*1234567890~',
      'HL*2*1*B~',
      'REF*MN*5551234567~',
      'IT1**1*EA*40.00**VP*Generic Plan~',
      'TDS*4000~',
      'SE*10*0001~',
    ].join('');
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'GENERIC', receiverId: 'ACME' }),
      gs: buildGs('GENERICEDI'),
      body,
    });
    const { bill } = await runEdi811Pipeline({
      buffer: Buffer.from(interchange, 'utf8'),
    });
    expect(bill.billing_period_end).toBe('2026-03-31');
    expect(bill.billing_period_start <= bill.billing_period_end).toBe(true);
    expect(bill.billing_period_start).toBe('2026-03-02');
  });

  it('swaps inverted DTM*150/151 so start <= end', async () => {
    // Carrier emits start AFTER end (a real-world dialect quirk).
    const body = [
      'ST*811*0001~',
      'BIG*20260401*INV-INV~',
      'N1*RE*ACME Mobile Co~',
      'DTM*150*20260331~',
      'DTM*151*20260301~',
      'HL*1**A~',
      'REF*9V*1234567890~',
      'HL*2*1*B~',
      'REF*MN*5551234567~',
      'IT1**1*EA*40.00**VP*Generic Plan~',
      'TDS*4000~',
      'SE*11*0001~',
    ].join('');
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'GENERIC', receiverId: 'ACME' }),
      gs: buildGs('GENERICEDI'),
      body,
    });
    const { bill } = await runEdi811Pipeline({
      buffer: Buffer.from(interchange, 'utf8'),
    });
    expect(bill.billing_period_start).toBe('2026-03-01');
    expect(bill.billing_period_end).toBe('2026-03-31');
  });

  // ───────────────────────────────────────────────────────────────────────
  // (Finding E) A $0 SAC device installment (D830) is a valid DPP row — the
  // schema allows monthly_cents: 0 (nonnegative). It must be RETAINED so
  // device binding for DPP / contract-rate rules still works.
  // ───────────────────────────────────────────────────────────────────────
  it('retains a $0 SAC device installment in dpp_installments', async () => {
    const body = [
      'ST*811*0001~',
      'BIG*20260401*INV-DPP0~',
      'N1*RE*ACME Mobile Co~',
      'DTM*150*20260301~',
      'DTM*151*20260331~',
      'HL*1**A~',
      'REF*9V*1234567890~',
      'HL*2*1*B~',
      'REF*MN*5551234567~',
      'PID*F****iPhone 15 Pro~',
      'IT1**1*EA*40.00**VP*Generic Plan~',
      buildSac({
        indicator: 'C',
        code: 'D830',
        amount: '0.00',
        description: 'iPhone 15 Pro Installment (paid off)',
        remainingPayments: 0,
        totalPayments: 24,
      }),
      'TDS*4000~',
      'CTT*1~',
      'SE*14*0001~',
    ].join('');
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'GENERIC', receiverId: 'ACME' }),
      gs: buildGs('GENERICEDI'),
      body,
    });
    const { bill } = await runEdi811Pipeline({ buffer: bufferOf(interchange) });
    const line = bill.accounts[0]!.lines[0]!;
    expect(line.dpp_installments).toHaveLength(1);
    expect(line.dpp_installments[0]!.monthly_cents).toBe(0);
    expect(line.dpp_installments[0]!.total_payments).toBe(24);
    expect(() => ExtractedBillSchema.parse(bill)).not.toThrow();
  });

  // ───────────────────────────────────────────────────────────────────────
  // (Finding F) An arithmetically-negative account subtotal is clamped to 0
  // so the schema's nonnegative() doesn't reject the bill, but the clamp must
  // be observable (console.warn with account last4 + the negative subtotal),
  // not silent — silent clamping masks an extraction error.
  // ───────────────────────────────────────────────────────────────────────
  it('warns (and clamps) when an account subtotal computes negative', async () => {
    // Account-level credit (-$50) outweighs the only line's base ($40): the
    // raw subtotal is -$10, which sumAccountTotal clamps to 0 with a warning.
    const body = [
      'ST*811*0001~',
      'BIG*20260401*INV-NEG~',
      'N1*RE*ACME Mobile Co~',
      'DTM*150*20260301~',
      'DTM*151*20260331~',
      'HL*1**A~',
      'REF*9V*1234567890~',
      // Account-level allowance (no current line yet) → account_level_credits.
      buildSac({ indicator: 'A', code: 'F050', amount: '50.00', description: 'Loyalty credit' }),
      'HL*2*1*B~',
      'REF*MN*5551234567~',
      'IT1**1*EA*40.00**VP*Generic Plan~',
      'TDS*4000~',
      'CTT*1~',
      'SE*13*0001~',
    ].join('');
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'GENERIC', receiverId: 'ACME' }),
      gs: buildGs('GENERICEDI'),
      body,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { bill } = await runEdi811Pipeline({ buffer: bufferOf(interchange) });
      expect(() => ExtractedBillSchema.parse(bill)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0]![0] as string;
      // Observability: surfaces the account last4 and the negative subtotal.
      expect(msg).toContain('7890');
      expect(msg).toContain('-1000');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts an unknown carrier and emits notes through the validated bill', async () => {
    const body = [
      'ST*811*0001~',
      'BIG*20260401*INV-X~',
      'N1*RE*ACME Mobile Co~',
      'DTM*150*20260301~',
      'DTM*151*20260331~',
      'HL*1**A~',
      'REF*9V*1234567890~',
      'HL*2*1*B~',
      'REF*MN*5551234567~',
      'IT1**1*EA*40.00**VP*Generic Plan~',
      'NTE*BIL*Account closed mid-cycle~',
      'TDS*4000~',
      'CTT*1~',
      'SE*13*0001~',
    ].join('');
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'GENERIC', receiverId: 'ACME' }),
      gs: buildGs('GENERICEDI'),
      body,
    });
    const { bill, detectedCarrier } = await runEdi811Pipeline({
      buffer: bufferOf(interchange),
    });
    expect(detectedCarrier).toBe('unknown');
    expect(bill.notes).toContain('Account closed mid-cycle');
  });
});
