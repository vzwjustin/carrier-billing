import { describe, expect, it } from 'vitest';

import {
  detectDelimiters,
  EdiParseError,
  findAllSegments,
  findSegment,
  looksLikeX12,
  parseX12,
  partitionTransactionSets,
} from '@/extraction/edi/parser';

// Standard X12 ISA (106 chars). Element=*, subelement=:, segment=~
const ISA =
  'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260509*0930*U*00501*000000001*0*P*:~';

const ENVELOPE_OPEN = `${ISA}GS*BL*SENDERID*RECEIVERID*20260509*0930*1*X*005010~ST*811*0001~`;
const ENVELOPE_CLOSE = 'SE*5*0001~GE*1*1~IEA*1*000000001~';

describe('looksLikeX12', () => {
  it('matches a buffer starting with ISA', () => {
    expect(looksLikeX12(Buffer.from(ISA))).toBe(true);
  });

  it('matches when leading whitespace precedes ISA', () => {
    expect(looksLikeX12(Buffer.from(`\n  ${ISA}`))).toBe(true);
  });

  it('does not match a PDF signature', () => {
    expect(looksLikeX12(Buffer.from('%PDF-1.7\n...'))).toBe(false);
  });

  it('does not match an empty buffer', () => {
    expect(looksLikeX12(Buffer.from(''))).toBe(false);
  });
});

describe('detectDelimiters', () => {
  it('reads element, subelement, and segment from a standard ISA', () => {
    expect(detectDelimiters(ISA)).toEqual({
      element: '*',
      subelement: ':',
      segment: '~',
    });
  });

  it('throws on a too-short ISA', () => {
    expect(() => detectDelimiters('ISA*00*')).toThrowError(EdiParseError);
  });

  it('throws when element and segment delimiters collide', () => {
    // Synthesized: replace `~` with `*` in the ISA → element collision.
    const bad = ISA.replace(/~$/, '*');
    expect(() => detectDelimiters(bad)).toThrowError(EdiParseError);
  });
});

describe('parseX12', () => {
  it('tokenizes a minimal envelope into segments', () => {
    const file = `${ENVELOPE_OPEN}${ENVELOPE_CLOSE}`;
    const { segments } = parseX12(file);
    const tags = segments.map((s) => s.tag);
    expect(tags).toEqual(['ISA', 'GS', 'ST', 'SE', 'GE', 'IEA']);
  });

  it('preserves empty elements between separators', () => {
    const file = `${ENVELOPE_OPEN}REF**ABC123~${ENVELOPE_CLOSE}`;
    const { segments } = parseX12(file);
    const ref = segments.find((s) => s.tag === 'REF');
    // REF*<empty>*ABC123 → elements = ['', 'ABC123']
    expect(ref?.elements).toEqual(['', 'ABC123']);
  });

  it('strips CRLF between segments', () => {
    const file = `${ENVELOPE_OPEN}\r\nN1*VN*Verizon~\n${ENVELOPE_CLOSE}`;
    const { segments } = parseX12(file);
    const n1 = segments.find((s) => s.tag === 'N1');
    expect(n1?.elements).toEqual(['VN', 'Verizon']);
  });

  it('throws on a buffer with no ISA', () => {
    expect(() => parseX12('GS*BL*A*B*20260101*0930*1*X*005010~')).toThrowError(
      EdiParseError,
    );
  });
});

describe('findSegment / findAllSegments', () => {
  const file = `${ENVELOPE_OPEN}N1*VN*Verizon~N1*BT*Acme Corp~${ENVELOPE_CLOSE}`;
  const { segments } = parseX12(file);

  it('returns the first match for findSegment', () => {
    const n1 = findSegment(segments, 'N1');
    expect(n1?.elements[1]).toBe('Verizon');
  });

  it('returns all matches for findAllSegments in order', () => {
    const all = findAllSegments(segments, 'N1');
    expect(all.map((s) => s.elements[1])).toEqual(['Verizon', 'Acme Corp']);
  });
});

describe('partitionTransactionSets', () => {
  it('groups segments between ST and SE', () => {
    const file = `${ENVELOPE_OPEN}REF*AN*123~${ENVELOPE_CLOSE}`;
    const { segments } = parseX12(file);
    const sets = partitionTransactionSets(segments);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.[0]?.tag).toBe('ST');
    expect(sets[0]?.[sets[0]!.length - 1]?.tag).toBe('SE');
    expect(sets[0]?.find((s) => s.tag === 'REF')).toBeTruthy();
  });
});
