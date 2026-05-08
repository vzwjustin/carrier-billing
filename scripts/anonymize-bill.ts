/**
 * scripts/anonymize-bill.ts
 *
 * Usage:
 *   pnpm tsx scripts/anonymize-bill.ts <input.pdf> <output-prefix>
 *
 * Extracts the text from a wireless bill PDF, redacts phone numbers and
 * account numbers, and writes:
 *   - <output-prefix>.txt    — the anonymized text dump (review-only)
 *   - <output-prefix>.json   — structured payload + redaction mapping
 *
 * This is intended as a *review aid* before committing test fixtures.
 *
 * TODO(phase-1.5): true PDF anonymization with pdf-lib redactions so we can
 * actually feed sanitized PDFs into the extraction pipeline. For Phase 1 we
 * only need to verify what's in the bill before we trust it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

type RedactionEntry = {
  kind: 'phone' | 'account';
  original: string;
  replacement: string;
};

const PHONE_RE = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
// Verizon-style 12-digit account numbers; preserve the last 4.
const ACCOUNT_RE = /\b\d{12}\b/g;

function fakePhoneFromIndex(idx: number): string {
  // Use the 555-01xx prefix block reserved for fictional numbers.
  const last4 = (100 + (idx % 9900)).toString().padStart(4, '0');
  return `555-555-${last4}`;
}

function maskAccount(original: string): string {
  const last4 = original.slice(-4);
  return `XXXXXXXX${last4}`;
}

function buildRedactor(): {
  apply: (text: string) => string;
  entries: RedactionEntry[];
} {
  const phoneMap = new Map<string, string>();
  const accountMap = new Map<string, string>();
  const entries: RedactionEntry[] = [];

  const apply = (text: string): string => {
    let out = text.replace(PHONE_RE, (match) => {
      const existing = phoneMap.get(match);
      if (existing) return existing;
      const replacement = fakePhoneFromIndex(phoneMap.size);
      phoneMap.set(match, replacement);
      entries.push({ kind: 'phone', original: match, replacement });
      return replacement;
    });

    out = out.replace(ACCOUNT_RE, (match) => {
      const existing = accountMap.get(match);
      if (existing) return existing;
      const replacement = maskAccount(match);
      accountMap.set(match, replacement);
      entries.push({ kind: 'account', original: match, replacement });
      return replacement;
    });

    return out;
  };

  return { apply, entries };
}

function usage(): never {
  process.stderr.write(
    'Usage: pnpm tsx scripts/anonymize-bill.ts <input.pdf> <output-prefix>\n',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !outputArg) usage();

  if (!inputArg.toLowerCase().endsWith('.pdf')) {
    process.stderr.write('Input must be a .pdf file.\n');
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const outputPrefix = path.resolve(outputArg).replace(/\.(pdf|txt|json)$/i, '');
  const txtPath = `${outputPrefix}.txt`;
  const jsonPath = `${outputPrefix}.json`;

  let inputBuffer: Buffer;
  try {
    inputBuffer = await fs.readFile(inputPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`Failed to read input PDF: ${message}\n`);
    process.exit(1);
  }

  let pdfText = '';
  try {
    // Dynamic import so the script doesn't fail at module load if pdf-parse is
    // unavailable in some environment.
    const mod = (await import('pdf-parse')) as unknown as {
      default?: (buf: Buffer) => Promise<{ text: string }>;
    };
    const pdfParse = mod.default;
    if (typeof pdfParse !== 'function') {
      throw new Error('pdf-parse default export is not a function');
    }
    const result = await pdfParse(inputBuffer);
    pdfText = result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`Failed to parse PDF: ${message}\n`);
    process.exit(1);
  }

  const { apply, entries } = buildRedactor();
  const anonymized = apply(pdfText);

  await fs.writeFile(txtPath, anonymized, 'utf8');
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        source: path.basename(inputPath),
        char_count: anonymized.length,
        redactions: entries,
        text: anonymized,
      },
      null,
      2,
    ),
    'utf8',
  );

  process.stdout.write(
    `Wrote ${txtPath} and ${jsonPath} (${entries.length} redactions).\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`anonymize-bill failed: ${message}\n`);
  process.exit(1);
});
