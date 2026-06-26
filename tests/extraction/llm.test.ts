/**
 * Gated LLM extraction tests.
 *
 * When RUN_LLM_TESTS=1 is set (see `pnpm test:llm`), this suite walks every
 * `<basename>.expected.json` in tests/fixtures/bills, looks for a sibling
 * `<basename>.pdf`, calls extractBill on it, and asserts a few structural
 * invariants against the golden JSON:
 *   - carrier matches
 *   - account count matches exactly
 *   - line count is within ±10% of expected (LLM may merge or split rows)
 *   - total_charges_cents is within $1 of expected
 *
 * Without RUN_LLM_TESTS=1 every assertion becomes `it.todo` so CI is unchanged
 * and we don't burn API credit. PDFs are not yet committed — the tests will
 * skip individual fixtures whose PDF is missing, even when running gated.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ExtractedBillSchema, type ExtractedBill } from '@/extraction/schema';

const SHOULD_RUN = process.env.RUN_LLM_TESTS === '1';
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'bills');

type FixturePair = {
  name: string;
  jsonPath: string;
  pdfPath: string;
  pdfExists: boolean;
};

function discoverFixtures(): FixturePair[] {
  let entries: string[];
  try {
    entries = readdirSync(FIXTURES_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.expected.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const base = file.replace(/\.expected\.json$/, '');
      const jsonPath = path.join(FIXTURES_DIR, file);
      const pdfPath = path.join(FIXTURES_DIR, `${base}.pdf`);
      return { name: base, jsonPath, pdfPath, pdfExists: existsSync(pdfPath) };
    });
}

function totalLineCount(bill: ExtractedBill): number {
  return bill.accounts.reduce((acc, a) => acc + a.lines.length, 0);
}

const fixtures = discoverFixtures();

describe('llm extraction', () => {
  if (!SHOULD_RUN) {
    // CI / default: declare the cases as todos so the intent is visible
    // but no API calls happen.
    it.todo('runs against fixture bills');
    it.todo('totals match the fixture within $1');
    it.todo('line counts match the fixture within ±10%');
    it.todo('account count matches the fixture exactly');
    it.todo('schema-validation retry recovers from a malformed first response');

    it('module loads', () => {
      expect(true).toBe(true);
    });
    return;
  }

  // Gated path. Lazy-import the extractor only when running so unset
  // ANTHROPIC_API_KEY doesn't crash CI module load.
  for (const fx of fixtures) {
    const tCase = fx.pdfExists ? it : it.skip;

    tCase(
      `${fx.name}: extractor output matches fixture invariants`,
      async () => {
        const expectedRaw = readFileSync(fx.jsonPath, 'utf8');
        const expected = ExtractedBillSchema.parse(JSON.parse(expectedRaw));

        const { extractBill } = (await import('@/extraction/llm')) as {
          extractBill: (buf: Buffer) => Promise<ExtractedBill>;
        };
        const pdfBuffer = readFileSync(fx.pdfPath);
        const actual = await extractBill(pdfBuffer);

        expect(actual.carrier).toBe(expected.carrier);
        expect(actual.accounts.length).toBe(expected.accounts.length);

        const expectedLines = totalLineCount(expected);
        const actualLines = totalLineCount(actual);
        const tolerance = Math.max(1, Math.ceil(expectedLines * 0.1));
        expect(Math.abs(actualLines - expectedLines)).toBeLessThanOrEqual(tolerance);

        expect(
          Math.abs(actual.total_charges_cents - expected.total_charges_cents),
        ).toBeLessThanOrEqual(100); // $1
      },
      120_000,
    );
  }

  if (fixtures.length === 0) {
    it.todo('no fixtures discovered — add JSON + PDF pairs under tests/fixtures/bills');
  }
});
