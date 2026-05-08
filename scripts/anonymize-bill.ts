/**
 * scripts/anonymize-bill.ts
 *
 * Usage:
 *   pnpm tsx scripts/anonymize-bill.ts <input.pdf> <output.pdf> [--dry-run]
 *
 * True PDF anonymization for committing test fixtures. Loads the input PDF,
 * extracts its text via pdf-parse, builds a redaction map (phone numbers,
 * account numbers, employee/contact names → realistic synthetic replacements),
 * applies the map to the text, and emits a NEW PDF whose pages contain the
 * cleaned text only. A sidecar JSON records the mapping for review.
 *
 * NOTE: This produces a TEXT-replicated anonymized PDF — original layout is
 * lost. For visual fidelity preservation use a PDF redaction tool that
 * supports positional matching (e.g., qpdf + pdftotext bbox).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

type RedactionKind = 'phone' | 'account' | 'name';

type RedactionEntry = {
  kind: RedactionKind;
  original: string;
  replacement: string;
};

type RedactionSummary = {
  phone: number;
  account: number;
  name: number;
};

// Phone numbers: 555-555-1212, 5555551212, (555) 555-1212, etc.
const PHONE_RE =
  /\b(?:\(\d{3}\)\s*|\d{3}[-.\s])?\d{3}[-.\s]?\d{4}\b|\b\d{10}\b/g;
// Verizon-style 12-digit account numbers; preserve the last 4 via masking.
const ACCOUNT_RE = /\b\d{12}\b/g;

// Static fake-name pool; reused across runs so output is deterministic per
// input order. Real names are detected on a best-effort heuristic only —
// reviewers should still spot-check the output JSON.
const FAKE_NAMES: readonly string[] = [
  'Avery Stone',
  'Blair Quinn',
  'Casey Rowe',
  'Drew Hayes',
  'Ellis Park',
  'Frankie Lane',
  'Gray Tatum',
  'Harper Vale',
  'Indigo West',
  'Jules Marsh',
  'Kai Bishop',
  'Lane Forester',
  'Morgan Reese',
  'Nico Bardot',
  'Onyx Carter',
  'Parker Holt',
  'Quincy Adair',
  'Reese Calder',
  'Sage Linley',
  'Tatum Pryor',
];

// Heuristic: a label like "User: Jane Smith" or "Name: Jane Smith" or
// "Employee: Jane Smith". We deliberately stay narrow — broad name matching
// hits too many false positives in carrier bill body text.
const LABELED_NAME_RE =
  /\b(User|Name|Employee|Contact|Bill\s*To|Account\s*Holder)\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;

function fakePhoneFromIndex(idx: number): string {
  // 555-prefixed fictional block; pad an offset for uniqueness.
  const last4 = ((idx % 10000) + 0).toString().padStart(4, '0');
  return `555-555-${last4}`;
}

function maskAccount(original: string): string {
  const last4 = original.slice(-4);
  return `XXXXXXXX${last4}`;
}

function fakeNameFromIndex(idx: number): string {
  const fallback = FAKE_NAMES[idx % FAKE_NAMES.length];
  return fallback ?? `Employee ${String.fromCharCode(65 + (idx % 26))}`;
}

type Redactor = {
  apply: (text: string) => string;
  entries: RedactionEntry[];
  summary: () => RedactionSummary;
};

function buildRedactor(): Redactor {
  const phoneMap = new Map<string, string>();
  const accountMap = new Map<string, string>();
  const nameMap = new Map<string, string>();
  const entries: RedactionEntry[] = [];

  const apply = (text: string): string => {
    // Names first (so we don't accidentally rewrite digits inside a name match).
    let out = text.replace(LABELED_NAME_RE, (_full, label: string, name: string) => {
      const existing = nameMap.get(name);
      const replacement = existing ?? fakeNameFromIndex(nameMap.size);
      if (!existing) {
        nameMap.set(name, replacement);
        entries.push({ kind: 'name', original: name, replacement });
      }
      return `${label}: ${replacement}`;
    });

    out = out.replace(PHONE_RE, (match) => {
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

  const summary = (): RedactionSummary => ({
    phone: phoneMap.size,
    account: accountMap.size,
    name: nameMap.size,
  });

  return { apply, entries, summary };
}

function usage(): never {
  process.stderr.write(
    'Usage: pnpm tsx scripts/anonymize-bill.ts <input.pdf> <output.pdf> [--dry-run]\n',
  );
  process.exit(1);
}

async function extractText(pdfBuffer: Buffer): Promise<string> {
  const mod = (await import('pdf-parse')) as unknown as {
    default?: (buf: Buffer) => Promise<{ text: string }>;
  };
  const pdfParse = mod.default;
  if (typeof pdfParse !== 'function') {
    throw new Error('pdf-parse default export is not a function');
  }
  const result = await pdfParse(pdfBuffer);
  return result.text;
}

// Roughly chunk the cleaned text into pages for the rebuilt PDF. pdf-parse
// uses form-feed (\f) as a page separator, so prefer that when present.
function splitIntoPages(text: string): string[] {
  if (text.includes('\f')) {
    return text.split('\f').map((p) => p.trim());
  }
  // Fallback: 60-line chunks so single-page text still renders sanely.
  const lines = text.split('\n');
  const chunkSize = 60;
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    pages.push(lines.slice(i, i + chunkSize).join('\n'));
  }
  return pages.length > 0 ? pages : [text];
}

type DrawCtx = {
  page: PDFPage;
  font: PDFFont;
  size: number;
  margin: number;
  lineHeight: number;
};

function drawWrappedText(ctx: DrawCtx, content: string): void {
  const { page, font, size, margin, lineHeight } = ctx;
  const { width, height } = page.getSize();
  const usableWidth = width - margin * 2;
  let cursorY = height - margin;

  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    if (line.length === 0) {
      cursorY -= lineHeight;
      continue;
    }

    // Word-wrap to fit page width.
    const words = line.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      const w = font.widthOfTextAtSize(candidate, size);
      if (w > usableWidth && current.length > 0) {
        page.drawText(current, { x: margin, y: cursorY, size, font });
        cursorY -= lineHeight;
        current = word;
        if (cursorY < margin) return;
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) {
      page.drawText(current, { x: margin, y: cursorY, size, font });
      cursorY -= lineHeight;
    }
    if (cursorY < margin) return;
  }
}

async function buildAnonymizedPdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const size = 9;
  const margin = 36;
  const lineHeight = 11;

  for (const pageText of pages) {
    const page = doc.addPage();
    drawWrappedText({ page, font, size, margin, lineHeight }, pageText);
  }

  return doc.save();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => !a.startsWith('--'));
  const inputArg = positional[0];
  const outputArg = positional[1];
  if (!inputArg || !outputArg) usage();

  if (!inputArg.toLowerCase().endsWith('.pdf')) {
    process.stderr.write('Input must be a .pdf file.\n');
    process.exit(1);
  }
  if (!outputArg.toLowerCase().endsWith('.pdf')) {
    process.stderr.write('Output must be a .pdf file.\n');
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(outputArg);
  const jsonPath = outputPath.replace(/\.pdf$/i, '.json');

  let inputBuffer: Buffer;
  try {
    inputBuffer = await fs.readFile(inputPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`Failed to read input PDF: ${message}\n`);
    process.exit(1);
  }

  let pdfText: string;
  try {
    pdfText = await extractText(inputBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`Failed to parse PDF: ${message}\n`);
    process.exit(1);
  }

  const { apply, entries, summary } = buildRedactor();
  const anonymizedText = apply(pdfText);
  const totals = summary();

  if (dryRun) {
    process.stdout.write(
      `[dry-run] would redact ${totals.phone} phone numbers, ${totals.account} account numbers, ${totals.name} names\n`,
    );
    for (const e of entries) {
      process.stdout.write(`  ${e.kind}: ${e.original} -> ${e.replacement}\n`);
    }
    return;
  }

  const pages = splitIntoPages(anonymizedText);
  const pdfBytes = await buildAnonymizedPdf(pages);

  await fs.writeFile(outputPath, pdfBytes);
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        source: path.basename(inputPath),
        output: path.basename(outputPath),
        page_count: pages.length,
        char_count: anonymizedText.length,
        summary: totals,
        redactions: entries,
      },
      null,
      2,
    ),
    'utf8',
  );

  process.stdout.write(
    `redacted ${totals.phone} phone numbers, ${totals.account} account numbers, ${totals.name} names\n`,
  );
  process.stdout.write(`wrote ${outputPath} and ${jsonPath}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`anonymize-bill failed: ${message}\n`);
  process.exit(1);
});
