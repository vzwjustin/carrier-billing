import { describe, expect, it } from 'vitest';

import { csvCell, csvRow, toCsv } from '@/lib/csv';

describe('csv helpers', () => {
  describe('csvCell', () => {
    it('passes through plain strings unquoted', () => {
      expect(csvCell('hello')).toBe('hello');
    });

    it('quotes values containing commas', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
    });

    it('quotes and escapes embedded double-quotes', () => {
      expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
    });

    it('quotes values with newlines (CR or LF)', () => {
      expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
      expect(csvCell('line1\rline2')).toBe('"line1\rline2"');
    });

    it('quotes values with leading or trailing whitespace', () => {
      expect(csvCell(' hello')).toBe('" hello"');
      expect(csvCell('hello ')).toBe('"hello "');
    });

    it('renders numbers and booleans without quoting', () => {
      expect(csvCell(42)).toBe('42');
      expect(csvCell(0)).toBe('0');
      expect(csvCell(true)).toBe('true');
    });

    it('renders null and undefined as empty string', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell(undefined)).toBe('');
    });

    it('guards against CSV injection by prefixing dangerous leading chars', () => {
      expect(csvCell('=SUM(A1:A10)')).toBe(`'=SUM(A1:A10)`);
      expect(csvCell('+1234567890')).toBe(`'+1234567890`);
      expect(csvCell('-1=2')).toBe(`'-1=2`);
      expect(csvCell('@cmd')).toBe(`'@cmd`);
    });

    it('serializes objects via JSON.stringify and quotes if needed', () => {
      expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    });
  });

  describe('csvRow', () => {
    it('joins cells with commas in order', () => {
      expect(csvRow(['a', 'b', 'c'])).toBe('a,b,c');
    });

    it('preserves empty cells', () => {
      expect(csvRow(['a', null, 'c'])).toBe('a,,c');
    });
  });

  describe('toCsv', () => {
    it('emits header + rows joined by CRLF', () => {
      const out = toCsv(['name', 'qty'], [
        ['apple', 3],
        ['pear', 1],
      ]);
      expect(out).toBe('name,qty\r\napple,3\r\npear,1');
    });

    it('produces only the header when no rows are supplied', () => {
      expect(toCsv(['a', 'b'], [])).toBe('a,b');
    });
  });
});
