/**
 * scripts/generate-fixture-pdf.ts
 *
 * Renders an ExtractedBill JSON fixture into a sibling .pdf the LLM can read.
 * No-arg form regenerates every <name>.expected.json under tests/fixtures/bills.
 * Single-arg form: tsx scripts/generate-fixture-pdf.ts <path-to-expected.json>.
 * Layout is plain text — LLM-readable, not visually faithful to a real bill.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  ExtractedBillSchema,
  type ExtractedBill,
  type ExtractedAccount,
  type ExtractedLine,
} from '../src/extraction/schema';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'tests', 'fixtures', 'bills');

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN_LEFT = 48;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 48;
const FONT_SIZE = 10;
const HEADING_SIZE = 14;
const TITLE_SIZE = 18;
const LINE_HEIGHT = 13;

type CarrierHeader = { display: string; banner: string };

function carrierHeader(carrier: ExtractedBill['carrier']): CarrierHeader {
  switch (carrier) {
    case 'verizon':
      return { display: 'Verizon Wireless — Business Account', banner: 'verizon wireless' };
    case 'att':
      return { display: 'AT&T Business Mobility', banner: 'AT&T' };
    case 'tmobile':
      return { display: 'T-Mobile for Business', banner: 'T-Mobile' };
    case 'unknown':
      return { display: 'Wireless Bill', banner: 'wireless' };
  }
}

// Helvetica's WinAnsi encoding rejects em-dashes, smart quotes, etc. Replace
// the few non-ASCII characters our fixtures actually use.
function sanitize(text: string): string {
  return text
    .replace(/[—–]/g, '-') // em/en dash
    .replace(/[‘’]/g, "'") // smart single quotes
    .replace(/[“”]/g, '"') // smart double quotes
    .replace(/•/g, '*') // bullet
    .replace(/[^\x20-\x7E]/g, '?'); // anything else
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

class PdfWriter {
  private readonly doc: PDFDocument;
  private readonly font: PDFFont;
  private readonly bold: PDFFont;
  private page: PDFPage;
  private cursorY: number;

  private constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont, page: PDFPage) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.page = page;
    this.cursorY = PAGE_HEIGHT - MARGIN_TOP;
  }

  static async create(): Promise<PdfWriter> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    return new PdfWriter(doc, font, bold, page);
  }

  private ensureSpace(): void {
    if (this.cursorY < MARGIN_BOTTOM + LINE_HEIGHT) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.cursorY = PAGE_HEIGHT - MARGIN_TOP;
    }
  }

  text(line: string, opts: { bold?: boolean; size?: number; indent?: number } = {}): void {
    this.ensureSpace();
    const size = opts.size ?? FONT_SIZE;
    const font = opts.bold ? this.bold : this.font;
    const x = MARGIN_LEFT + (opts.indent ?? 0);
    this.page.drawText(sanitize(line), {
      x,
      y: this.cursorY - size,
      size,
      font,
      color: rgb(0, 0, 0),
    });
    const advance = Math.max(LINE_HEIGHT, size + 3);
    this.cursorY -= advance;
  }

  blank(): void {
    this.cursorY -= LINE_HEIGHT / 2;
  }

  async toBytes(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

function renderLine(w: PdfWriter, line: ExtractedLine, idx: number): void {
  const suspended = line.is_suspended ? ' [SUSPENDED]' : '';
  const label = line.user_label ?? `Line ${idx + 1}`;
  const mdn = line.mdn_last4 ? `(***-***-${line.mdn_last4})` : '';
  w.text(`Line ${idx + 1}: ${label} ${mdn}${suspended}`, { bold: true, indent: 12 });
  if (line.device) w.text(`Device: ${line.device}`, { indent: 24 });
  if (line.plan_name) {
    const base = line.plan_base_cents !== null ? ` @ ${formatCents(line.plan_base_cents)}/mo` : '';
    w.text(`Plan: ${line.plan_name}${base}`, { indent: 24 });
  }
  const usage: string[] = [];
  if (line.data_used_gb !== null) usage.push(`Data: ${line.data_used_gb} GB`);
  if (line.voice_used_min !== null) usage.push(`Voice: ${line.voice_used_min} min`);
  if (line.sms_used_count !== null) usage.push(`SMS: ${line.sms_used_count}`);
  if (usage.length > 0) w.text(`Usage: ${usage.join(', ')}`, { indent: 24 });

  for (const f of line.features) {
    w.text(
      `Feature: ${f.name} [category=${f.category}] - ${formatCents(f.monthly_cents)}/mo`,
      { indent: 24 },
    );
  }
  for (const c of line.credits) {
    const exp = c.expires_on ? `, expires ${c.expires_on}` : '';
    const promo = c.is_promo ? ', promotional' : '';
    w.text(`Credit: ${c.name} - ${formatCents(c.monthly_cents)}/mo${exp}${promo}`, {
      indent: 24,
    });
  }
  for (const d of line.dpp_installments) {
    const remaining =
      d.remaining_payments !== null && d.total_payments !== null
        ? ` (${d.total_payments - d.remaining_payments} of ${d.total_payments} paid, ${d.remaining_payments} remaining)`
        : '';
    w.text(
      `Device Payment: ${d.device} - ${formatCents(d.monthly_cents)}/mo${remaining}`,
      { indent: 24 },
    );
  }
  w.blank();
}

function renderAccount(w: PdfWriter, account: ExtractedAccount, idx: number): void {
  const last4 = account.account_number_last4 ? `****${account.account_number_last4}` : 'unknown';
  const label = account.label ?? `Account ${idx + 1}`;
  w.text(`Account ${idx + 1}: ${label} (${last4})`, { bold: true, size: HEADING_SIZE });
  w.text(`Total charges: ${formatCents(account.total_charges_cents)}`);
  if (account.taxes_fees_cents !== null) {
    w.text(`Taxes & fees: ${formatCents(account.taxes_fees_cents)}`);
  }
  for (const c of account.account_level_credits) {
    const exp = c.expires_on ? `, expires ${c.expires_on}` : '';
    const promo = c.is_promo ? ', promotional' : '';
    w.text(
      `Account Credit: ${c.name} - ${formatCents(c.monthly_cents)}/mo${exp}${promo}`,
      { indent: 12 },
    );
  }
  w.blank();
  account.lines.forEach((line, i) => renderLine(w, line, i));
}

async function renderBill(bill: ExtractedBill): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const header = carrierHeader(bill.carrier);
  w.text(header.banner, { bold: true, size: TITLE_SIZE });
  w.text(header.display);
  w.text(`Billing period: ${bill.billing_period_start} to ${bill.billing_period_end}`);
  w.text(`Total charges: ${formatCents(bill.total_charges_cents)}`);
  w.text(`Carrier: ${bill.carrier}`);
  w.blank();

  bill.accounts.forEach((account, i) => renderAccount(w, account, i));

  if (bill.notes.length > 0) {
    w.text('Notes:', { bold: true });
    for (const note of bill.notes) {
      w.text(`- ${note}`, { indent: 12 });
    }
  }

  return w.toBytes();
}

async function generateFromJsonPath(jsonPath: string): Promise<string> {
  const raw = await fs.readFile(jsonPath, 'utf8');
  const parsed = ExtractedBillSchema.parse(JSON.parse(raw));
  const bytes = await renderBill(parsed);
  const pdfPath = jsonPath.replace(/\.expected\.json$/, '.pdf');
  await fs.writeFile(pdfPath, bytes);
  return pdfPath;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  let written = 0;

  if (arg) {
    const out = await generateFromJsonPath(path.resolve(arg));
    process.stdout.write(`wrote ${out}\n`);
    return;
  }

  const entries = await fs.readdir(FIXTURES_DIR);
  const jsons = entries.filter((f) => f.endsWith('.expected.json')).sort();
  for (const file of jsons) {
    const out = await generateFromJsonPath(path.join(FIXTURES_DIR, file));
    process.stdout.write(`wrote ${path.relative(process.cwd(), out)}\n`);
    written += 1;
  }
  process.stdout.write(`generated ${written} PDF fixtures\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`generate-fixture-pdf failed: ${message}\n`);
  process.exit(1);
});
