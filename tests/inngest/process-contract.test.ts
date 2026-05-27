import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { processContractFn } from '@/inngest/functions/process-contract';
import { functions } from '@/inngest/functions';

/**
 * Tests for the process-contract Inngest function.
 *
 * The Inngest harness isn't available in unit tests, so the durable
 * primitives (status guards, ownership recheck, scrubbed failure_reason) are
 * pinned via source-level assertions — same pattern as process-bill.test.ts.
 * String assertions are brittle but cheap insurance against regressions that
 * silently clobber terminal state. If you're refactoring a step here, update
 * the matching assertion — do not delete it without a discussion.
 */

const CONTRACT_SRC = readFileSync(
  resolve(
    __dirname,
    '..',
    '..',
    'src',
    'inngest',
    'functions',
    'process-contract.ts',
  ),
  'utf8',
);

describe('processContractFn — registration', () => {
  it('is registered with the expected id', () => {
    expect(processContractFn.id()).toContain('process-contract');
  });

  it('appears in the exported functions registry', () => {
    expect(functions).toContain(processContractFn);
  });

  it('exposes a stable, non-empty name', () => {
    expect(typeof processContractFn.name).toBe('string');
    expect(processContractFn.name.length).toBeGreaterThan(0);
  });
});

describe('processContractFn — event payload validation', () => {
  it('parses event.data through ContractUploadedDataSchema at the boundary', () => {
    expect(CONTRACT_SRC).toMatch(
      /parseEventData\(\s*['"]contract\.uploaded['"]\s*,\s*event\.data\s*,\s*ContractUploadedDataSchema/,
    );
  });
});

describe('processContractFn — mark-extracting status guard', () => {
  function getMarkExtractingBlock(): string {
    const idx = CONTRACT_SRC.indexOf('mark-extracting');
    expect(idx).toBeGreaterThan(-1);
    return CONTRACT_SRC.slice(idx, idx + 3500);
  }

  it('selects user_id + status before flipping (ownership recheck)', () => {
    const block = getMarkExtractingBlock();
    expect(block).toMatch(/\.select\(['"]id, user_id, status['"]\)/);
  });

  it('treats a missing row as `not-found` (does not throw)', () => {
    const block = getMarkExtractingBlock();
    expect(block).toMatch(/not-found/);
  });

  it('flips ownership-mismatch contracts to failed with a fixed reason', () => {
    const block = getMarkExtractingBlock();
    expect(block).toMatch(/ownership-mismatch/);
    // Must also write the failure_reason back to the row so the user sees a
    // stable terminal state instead of an indefinite "pending".
    expect(block).toMatch(/failure_reason:\s*['"]ownership-mismatch['"]/);
  });

  it('UPDATE chains .eq("status", "pending") so retries cannot re-flip', () => {
    const block = getMarkExtractingBlock();
    expect(block).toMatch(/\.eq\(['"]status['"]\s*,\s*['"]pending['"]\)/);
  });

  it('reads back the rows-affected count via .select("id")', () => {
    const block = getMarkExtractingBlock();
    expect(block).toMatch(/\.select\(['"]id['"]\)/);
  });

  it('short-circuits on 0 rows affected (no throw, returns skip)', () => {
    const block = getMarkExtractingBlock();
    expect(block).toMatch(/already-advanced/);
    expect(block).toMatch(/affected\s*===?\s*0|affected\s*<\s*1/);
  });
});

describe('processContractFn — persist step', () => {
  function getPersistBlock(): string {
    const idx = CONTRACT_SRC.indexOf("'persist'");
    expect(idx).toBeGreaterThan(-1);
    return CONTRACT_SRC.slice(idx, idx + 3500);
  }

  it('UPDATE chains .eq("status", "extracting") so a retry of an already-parsed contract is a no-op', () => {
    const block = getPersistBlock();
    expect(block).toMatch(/\.eq\(['"]status['"]\s*,\s*['"]extracting['"]\)/);
  });

  it('flips status to "parsed" on success', () => {
    const block = getPersistBlock();
    expect(block).toMatch(/status:\s*['"]parsed['"]/);
  });

  it('clears failure_reason on success (terminal cleanup)', () => {
    const block = getPersistBlock();
    expect(block).toMatch(/failure_reason:\s*null/);
  });

  it('replaces contract_terms via delete-then-insert (idempotent on retry)', () => {
    const block = getPersistBlock();
    expect(block).toMatch(/\.from\(['"]contract_terms['"]\)\s*\.delete\(\)/);
    expect(block).toMatch(/\.from\(['"]contract_terms['"]\)\.insert\(/);
  });
});

describe('processContractFn — mark-failed path', () => {
  function getMarkFailedBlock(): string {
    const idx = CONTRACT_SRC.indexOf('mark-failed');
    expect(idx).toBeGreaterThan(-1);
    return CONTRACT_SRC.slice(idx, idx + 2000);
  }

  it('scrubs the failure_reason before writing (PII discipline)', () => {
    // The scrubString helper must wrap the raw error before it lands in the
    // DB — otherwise a partial bill string or filename can leak there.
    expect(CONTRACT_SRC).toMatch(/scrubString\(rawMessage\)/);
  });

  it('truncates failure_reason to bound DB row size', () => {
    expect(CONTRACT_SRC).toMatch(/FAILURE_REASON_MAX\s*=\s*500/);
    expect(CONTRACT_SRC).toMatch(/truncate\(scrubString\(rawMessage\),\s*FAILURE_REASON_MAX\)/);
  });

  it('only flips to "failed" from in-flight states (never stomps "parsed")', () => {
    const block = getMarkFailedBlock();
    expect(block).toMatch(
      /\.in\(['"]status['"]\s*,\s*\[\s*['"]pending['"]\s*,\s*['"]extracting['"]\s*,\s*['"]failed['"]\s*\]/,
    );
  });

  it('re-throws after marking failed so Inngest sees the function as failed', () => {
    // The outer catch ends with `throw err;` — this is what surfaces the
    // failure to the Inngest function-level retry/dead-letter system.
    expect(CONTRACT_SRC).toMatch(/throw err;/);
  });
});

describe('processContractFn — extract step', () => {
  it('throws when the storage download fails (so Inngest retries)', () => {
    expect(CONTRACT_SRC).toMatch(/storage download failed/);
  });

  it('throws (does not silently succeed) when extractContract returns ok:false', () => {
    // The boundary translation `if (!result.ok) throw new Error(...)` is what
    // funnels a soft extract failure into the mark-failed path.
    expect(CONTRACT_SRC).toMatch(/if \(!result\.ok\)/);
    expect(CONTRACT_SRC).toMatch(/contract-extract:/);
  });
});

describe('processContractFn — audit trail', () => {
  it('logs a contract_uploaded trail event on success', () => {
    expect(CONTRACT_SRC).toMatch(/logTrailEvent\(/);
    expect(CONTRACT_SRC).toMatch(/eventType:\s*['"]contract_uploaded['"]/);
  });
});
