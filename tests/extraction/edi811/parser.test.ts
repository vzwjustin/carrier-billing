import { describe, it, expect } from 'vitest';
import { parseEdi811, Edi811ParseError, el, elOrNull } from '@/extraction/edi811/parser';
import { buildIsa, buildGs, buildInterchange } from './fixtures/build';

const SIMPLE_BODY = [
  'ST*811*0001~',
  'BIG*20260401*INV-12345*20260301*PO-123~',
  'N1*RE*Verizon Wireless~',
  'N1*BT*ACME CORP~',
  'CTT*0~',
  'SE*5*0001~',
].join('');

describe('parseEdi811', () => {
  it('parses a well-formed interchange and returns envelope + segments', () => {
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'VZW', receiverId: 'ACME' }),
      gs: buildGs('VZWBILLING'),
      body: SIMPLE_BODY,
    });
    const out = parseEdi811(interchange);

    expect(out.envelope.elementSep).toBe('*');
    expect(out.envelope.segmentTerminator).toBe('~');
    expect(out.envelope.componentSep).toBe(':');
    expect(out.envelope.senderId).toBe('VZW');
    expect(out.envelope.receiverId).toBe('ACME');
    expect(out.envelope.controlNumber).toBe('000000001');
    expect(out.envelope.applicationSenderCode).toBe('VZWBILLING');

    const ids = out.segments.map((s) => s.id);
    expect(ids).toEqual(['ST', 'BIG', 'N1', 'N1', 'CTT', 'SE']);
    expect(ids).not.toContain('GS');
    expect(ids).not.toContain('GE');
    expect(ids).not.toContain('IEA');
  });

  it('exposes element accessors that handle missing trailing fields', () => {
    const interchange = buildInterchange({
      isa: buildIsa({ senderId: 'VZW', receiverId: 'ACME' }),
      gs: buildGs('VZWBILLING'),
      body: SIMPLE_BODY,
    });
    const { segments } = parseEdi811(interchange);
    const big = segments.find((s) => s.id === 'BIG');
    expect(big).toBeDefined();
    if (!big) throw new Error('unreachable');
    expect(el(big, 1)).toBe('20260401');
    expect(el(big, 2)).toBe('INV-12345');
    expect(elOrNull(big, 99)).toBeNull();
  });

  it('strips inter-segment whitespace (newlines, CRs, tabs)', () => {
    const isa = buildIsa({ senderId: 'VZW', receiverId: 'ACME' });
    const gs = buildGs('VZWBILLING');
    const noisy = `${isa}\n${gs}\nST*811*0001~\r\nN1*RE*Verizon~\n\tCTT*0~\nSE*3*0001~\nGE*1*1~\nIEA*1*000000001~`;
    const out = parseEdi811(noisy);
    expect(out.segments.map((s) => s.id)).toEqual(['ST', 'N1', 'CTT', 'SE']);
  });

  it('honours non-default separators declared in the ISA header', () => {
    const isa = buildIsa({
      senderId: 'TMUS',
      receiverId: 'ACME',
      elementSep: '|',
      segmentTerminator: "'",
      componentSep: '^',
    });
    const body = "ST|811|0001'BIG|20260401|INV-9'N1|RE|T-Mobile US'CTT|0'SE|4|0001'";
    const ge = "GE|1|1'";
    const iea = "IEA|1|000000001'";
    const interchange = `${isa}GS|IN|TMUS|ACME|20260401|1200|1|X|004010'${body}${ge}${iea}`;
    const out = parseEdi811(interchange);
    expect(out.envelope.elementSep).toBe('|');
    expect(out.envelope.segmentTerminator).toBe("'");
    expect(out.envelope.componentSep).toBe('^');
    expect(out.segments.map((s) => s.id)).toEqual(['ST', 'BIG', 'N1', 'CTT', 'SE']);
  });

  it('rejects input that does not start with ISA', () => {
    expect(() => parseEdi811('GARBAGE'.repeat(20))).toThrow(Edi811ParseError);
  });

  it('rejects input shorter than the minimum interchange size', () => {
    expect(() => parseEdi811('ISA*too short')).toThrow(Edi811ParseError);
  });

  it('rejects an interchange missing the ST/SE markers', () => {
    const isa = buildIsa({ senderId: 'VZW', receiverId: 'ACME' });
    const gs = buildGs('VZWBILLING');
    const noTransaction = `${isa}${gs}N1*RE*Verizon~GE*0*1~IEA*1*000000001~`;
    expect(() => parseEdi811(noTransaction)).toThrow(/ST\/SE/);
  });
});
