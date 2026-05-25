import { describe, it, expect } from 'vitest';
import { detectCarrier } from '@/extraction/detect';

describe('detectCarrier', () => {
  it('detects Verizon from a Business header', () => {
    const text = `
      Verizon Business
      Account number: ************1234
      Billing period: Apr 1, 2026 - Apr 30, 2026
    `;
    expect(detectCarrier(text)).toBe('verizon');
  });

  it('detects Verizon from a "Verizon Wireless" header', () => {
    expect(detectCarrier('VERIZON WIRELESS — Bill Summary')).toBe('verizon');
  });

  it('detects AT&T from "AT&T Mobility" header', () => {
    const text = `
      AT&T Mobility
      Wireless Account Statement
    `;
    expect(detectCarrier(text)).toBe('att');
  });

  it('detects AT&T from "AT&T Business" header', () => {
    expect(detectCarrier('AT&T Business — Statement')).toBe('att');
  });

  it('detects T-Mobile from a "T-Mobile for Business" header', () => {
    const text = `
      T-Mobile for Business
      Account Summary
    `;
    expect(detectCarrier(text)).toBe('tmobile');
  });

  it('detects T-Mobile from spaced "T Mobile" variant', () => {
    expect(detectCarrier('Welcome to T Mobile, your business account.')).toBe(
      'tmobile',
    );
  });

  it('returns "unknown" for unrelated text', () => {
    expect(detectCarrier('Lorem ipsum dolor sit amet')).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(detectCarrier('')).toBe('unknown');
  });

  // Precedence: Verizon is checked first (among the MNOs), so a bill that
  // is clearly Verizon but happens to mention "AT&T" elsewhere (e.g.
  // competitive comparison, ported-in number history) still classifies as
  // Verizon.
  it('prefers Verizon when both Verizon and AT&T appear (Verizon header wins)', () => {
    const text = `
      Verizon Business — Statement
      Note: customer ported in from AT&T Mobility on 2025-12-01.
    `;
    expect(detectCarrier(text)).toBe('verizon');
  });

  // --- MVNOs + regional carriers (added with migration 0032) ----------------

  it('detects US Cellular from a "U.S. Cellular" header (periods + spaces)', () => {
    const text = `
      U.S. Cellular Business
      Account Statement
    `;
    expect(detectCarrier(text)).toBe('uscellular');
  });

  it('detects US Cellular from the spaced "US Cellular" variant', () => {
    expect(detectCarrier('Your US Cellular bill summary')).toBe('uscellular');
  });

  it('detects Spectrum Mobile from a "Spectrum Mobile" header', () => {
    const text = `
      Spectrum Mobile
      Statement of charges
    `;
    expect(detectCarrier(text)).toBe('spectrum');
  });

  it('detects Spectrum from the secondary "Charter Communications" brand', () => {
    // Older Charter corporate-billing letterheads omit "Spectrum Mobile" and
    // print only the parent-company name. The secondary signal catches that.
    expect(detectCarrier('Charter Communications — Mobile Services')).toBe(
      'spectrum',
    );
  });

  it('detects Xfinity Mobile from an "Xfinity Mobile" header', () => {
    expect(detectCarrier('Xfinity Mobile — Monthly Statement')).toBe('xfinity');
  });

  it('detects Xfinity from the parent "Comcast" brand', () => {
    expect(detectCarrier('Comcast Corporation — Wireless Services')).toBe(
      'xfinity',
    );
  });

  it('detects Cricket Wireless from a "Cricket Wireless" header', () => {
    expect(detectCarrier('Cricket Wireless — Account Summary')).toBe('cricket');
  });

  // --- MVNO-vs-parent tie-breaker -------------------------------------------
  // When both an MVNO and its underlying network appear in the bill text,
  // we prefer the MVNO match. Operators want to dispute against the actual
  // reseller (Spectrum / Xfinity / Cricket), not the underlying network.

  it('prefers Spectrum over Verizon when both appear (MVNO tie-breaker)', () => {
    const text = `
      Spectrum Mobile
      Account Statement
      Network: Verizon Wireless 5G UW
    `;
    expect(detectCarrier(text)).toBe('spectrum');
  });

  it('prefers Xfinity over Verizon when both appear (MVNO tie-breaker)', () => {
    const text = `
      Xfinity Mobile
      Statement of charges
      Powered by the Verizon Wireless network.
    `;
    expect(detectCarrier(text)).toBe('xfinity');
  });

  it('prefers Cricket over AT&T when both appear (MVNO tie-breaker)', () => {
    const text = `
      Cricket Wireless — Statement
      Network operated by AT&T Mobility.
    `;
    expect(detectCarrier(text)).toBe('cricket');
  });
});
