import { describe, it, expect } from 'vitest';
import { detectCarrierFromEdi } from '@/extraction/edi811/detect';
import type { Edi811Envelope, Edi811Segment } from '@/extraction/edi811/parser';

const baseEnvelope = (overrides: Partial<Edi811Envelope> = {}): Edi811Envelope => ({
  elementSep: '*',
  segmentTerminator: '~',
  componentSep: ':',
  senderId: '',
  receiverId: '',
  controlNumber: '000000001',
  applicationSenderCode: null,
  ...overrides,
});

const remitTo = (name: string): Edi811Segment => ({
  id: 'N1',
  elements: ['N1', 'RE', name],
});

describe('detectCarrierFromEdi', () => {
  it('detects Verizon from ISA06 sender id', () => {
    expect(detectCarrierFromEdi(baseEnvelope({ senderId: 'VZW' }), [])).toBe(
      'verizon',
    );
    expect(
      detectCarrierFromEdi(baseEnvelope({ senderId: 'CELLCO' }), []),
    ).toBe('verizon');
  });

  it('detects AT&T from sender id variants', () => {
    expect(detectCarrierFromEdi(baseEnvelope({ senderId: 'ATT' }), [])).toBe('att');
    expect(
      detectCarrierFromEdi(baseEnvelope({ senderId: 'ATTMOBILITY' }), []),
    ).toBe('att');
    expect(
      detectCarrierFromEdi(baseEnvelope({ senderId: 'CINGULAR' }), []),
    ).toBe('att');
  });

  it('detects T-Mobile from sender id (incl. legacy SPRINT)', () => {
    expect(detectCarrierFromEdi(baseEnvelope({ senderId: 'TMUS' }), [])).toBe(
      'tmobile',
    );
    expect(
      detectCarrierFromEdi(baseEnvelope({ senderId: 'TMOBILE' }), []),
    ).toBe('tmobile');
    expect(
      detectCarrierFromEdi(baseEnvelope({ senderId: 'SPRINT' }), []),
    ).toBe('tmobile');
  });

  it('falls back to N1*RE party name when ids are unrecognised', () => {
    expect(
      detectCarrierFromEdi(
        baseEnvelope({ senderId: 'GENERICEDI' }),
        [remitTo('Verizon Wireless')],
      ),
    ).toBe('verizon');
    expect(
      detectCarrierFromEdi(
        baseEnvelope({ senderId: 'GENERICEDI' }),
        [remitTo('AT&T Mobility LLC')],
      ),
    ).toBe('att');
    expect(
      detectCarrierFromEdi(
        baseEnvelope({ senderId: 'GENERICEDI' }),
        [remitTo('T-Mobile USA, Inc.')],
      ),
    ).toBe('tmobile');
  });

  it('returns unknown when nothing matches', () => {
    expect(
      detectCarrierFromEdi(
        baseEnvelope({ senderId: 'ACME', receiverId: 'CUSTOMER' }),
        [remitTo('Some Unknown Carrier')],
      ),
    ).toBe('unknown');
  });

  it('prefers GS02 application sender code when ISA ids are blank', () => {
    expect(
      detectCarrierFromEdi(
        baseEnvelope({ senderId: '', applicationSenderCode: 'TMUS' }),
        [],
      ),
    ).toBe('tmobile');
  });
});
