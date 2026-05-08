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

  // Precedence: Verizon is checked first, so a bill that is clearly Verizon
  // but happens to mention "AT&T" elsewhere (e.g. competitive comparison,
  // ported-in number history) still classifies as Verizon.
  it('prefers Verizon when both Verizon and AT&T appear (Verizon header wins)', () => {
    const text = `
      Verizon Business — Statement
      Note: customer ported in from AT&T Mobility on 2025-12-01.
    `;
    expect(detectCarrier(text)).toBe('verizon');
  });
});
