/**
 * Validates every committed `*.expected.json` fixture against
 * ExtractedBillSchema. This is the cheap CI guardrail that catches schema
 * drift the moment we add a required field — without needing to call the
 * LLM. Real PDFs (when added) live alongside as `<basename>.pdf`; the
 * gated llm.test.ts uses them.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ExtractedBillSchema } from '@/extraction/schema';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'bills');

function fixtureFiles(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(FIXTURES_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.expected.json'))
    .sort((a, b) => a.localeCompare(b));
}

describe('committed bill fixtures', () => {
  const files = fixtureFiles();

  it('has at least one fixture file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} validates against ExtractedBillSchema`, () => {
      const raw = readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
      const json: unknown = JSON.parse(raw);
      const result = ExtractedBillSchema.safeParse(json);
      if (!result.success) {
        throw new Error(
          `Schema validation failed for ${file}:\n${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
      expect(result.success).toBe(true);
    });

    it(`${file} has structurally consistent totals (account sum equals top-level)`, () => {
      const raw = readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
      const json = JSON.parse(raw) as { total_charges_cents: number; accounts: Array<{ total_charges_cents: number }> };
      const sum = json.accounts.reduce((acc, a) => acc + a.total_charges_cents, 0);
      expect(sum).toBe(json.total_charges_cents);
    });
  }
});
