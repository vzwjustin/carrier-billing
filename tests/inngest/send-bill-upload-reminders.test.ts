import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sendBillUploadRemindersFn } from '@/inngest/functions/send-bill-upload-reminders';
import { functions } from '@/inngest/functions';

/**
 * Tests for the send-bill-upload-reminders Inngest function.
 *
 * The function is gated behind BILL_REMINDER_ENABLED=true and runs on a
 * monthly cron. Until a verified Resend domain is configured (FROM_ADDRESS
 * carries a TODO(domain)), the dry-run gate is the entire safety story — a
 * regression that removed it would mass-send from an unverified domain on
 * the first day of the month and burn the sender reputation.
 *
 * Source-level checks pin the load-bearing pieces: dry-run gate, PII
 * discipline (no email addresses in logs), cohort size cap.
 */

const SRC = readFileSync(
  resolve(
    __dirname,
    '..',
    '..',
    'src',
    'inngest',
    'functions',
    'send-bill-upload-reminders.ts',
  ),
  'utf8',
);

describe('sendBillUploadRemindersFn — registration', () => {
  it('is registered with the expected id', () => {
    expect(sendBillUploadRemindersFn.id()).toContain('send-bill-upload-reminders');
  });

  it('appears in the exported functions registry', () => {
    expect(functions).toContain(sendBillUploadRemindersFn);
  });

  it('exposes a stable, non-empty name', () => {
    expect(typeof sendBillUploadRemindersFn.name).toBe('string');
    expect(sendBillUploadRemindersFn.name.length).toBeGreaterThan(0);
  });
});

describe('sendBillUploadRemindersFn — safety gate', () => {
  it('runs on a monthly cron (day 1)', () => {
    // The cron string `0 15 1 * *` = 15:00 UTC on day 1 of every month.
    expect(SRC).toMatch(/cron:\s*['"]0\s+15\s+1\s+\*\s+\*['"]/);
  });

  it('reads BILL_REMINDER_ENABLED from env and compares against "true" (string)', () => {
    // String compare is intentional — env values are always strings.
    expect(SRC).toMatch(/env\.BILL_REMINDER_ENABLED\s*===\s*['"]true['"]/);
  });

  it('returns dryRun:true without calling Resend when not enabled', () => {
    // The early return on `!enabled` is what keeps the function silent.
    expect(SRC).toMatch(/if\s*\(\s*!enabled\s*\)/);
    expect(SRC).toMatch(/dryRun:\s*true/);
  });

  it('uses dryRun:false in the enabled-path return shape', () => {
    expect(SRC).toMatch(/dryRun:\s*false/);
  });

  it('caps the recipient cohort at MAX_RECIPIENTS = 1000', () => {
    expect(SRC).toMatch(/MAX_RECIPIENTS\s*=\s*1000/);
    expect(SRC).toMatch(/\.limit\(MAX_RECIPIENTS\)/);
  });

  it('uses INACTIVITY_DAYS = 30 to define the recent-activity cutoff', () => {
    expect(SRC).toMatch(/INACTIVITY_DAYS\s*=\s*30/);
  });
});

describe('sendBillUploadRemindersFn — PII discipline', () => {
  it('logs only the cohort count + enabled flag — never email addresses', () => {
    // The two logger.info() call sites must contain only counts/booleans.
    const cohortLog = SRC.match(/logger\.info\([^)]*cohort selected[^)]*\)/s);
    expect(cohortLog, 'cohort logger.info missing').not.toBeNull();
    expect(cohortLog?.[0]).not.toMatch(/email/i);

    const doneLog = SRC.match(/logger\.info\([^)]*done[^)]*\)/s);
    expect(doneLog, 'done logger.info missing').not.toBeNull();
    expect(doneLog?.[0]).not.toMatch(/email/i);
  });

  it('select-due-users step does not log the cohort emails', () => {
    // The handler must not pass raw cohort emails to any logger.* call.
    expect(SRC).not.toMatch(/logger\.\w+\([^)]*email:/);
  });
});

describe('sendBillUploadRemindersFn — Resend error handling', () => {
  it('throws on Resend error so Inngest retries', () => {
    expect(SRC).toMatch(/throw new Error\(`resend send failed/);
  });

  it('extracts only the error name (not the full body) for the rethrown message', () => {
    // Logging the full Resend error body would leak PII (recipient email).
    // The handler must coerce to the `name` field only.
    expect(SRC).toMatch(/\(response\.error as \{ name\?: unknown \}\)\.name/);
  });
});

describe('sendBillUploadRemindersFn — cohort selection', () => {
  it('filters to users without a completed audit since the cutoff', () => {
    expect(SRC).toMatch(/\.eq\(['"]status['"]\s*,\s*['"]completed['"]\)/);
    expect(SRC).toMatch(/\.gte\(['"]created_at['"]\s*,\s*cutoff\)/);
  });

  it('drops profiles with no email', () => {
    expect(SRC).toMatch(/!!p\.email/);
  });
});
