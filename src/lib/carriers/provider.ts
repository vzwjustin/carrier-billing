import { randomBytes } from 'node:crypto';

import type { Carrier } from './types';

// ---------------------------------------------------------------------------
// SIMULATED carrier provider.
//
// Verizon, AT&T, and T-Mobile do not expose a public consumer billing API,
// so a literal "log in to the carrier and pull the bill" integration is not
// possible. This adapter encapsulates that boundary: every function here is a
// deterministic simulation. If a real partner/EDI feed is ever obtained, swap
// this module's implementation — the call sites and DB shape stay the same.
// ---------------------------------------------------------------------------

export interface ProviderAuthResult {
  ok: boolean;
  accountLabel: string | null;
  error: string | null;
}

export interface ProviderSyncResult {
  ok: boolean;
  syncedAt: string;
  error: string | null;
}

function fakeAccountLast4(): string {
  // Non-PII synthetic label so the UI has something to show.
  return randomBytes(2).toString('hex').slice(0, 4);
}

export async function authenticate(carrier: Carrier): Promise<ProviderAuthResult> {
  // Simulated handshake. Always succeeds with a synthetic account label.
  return {
    ok: true,
    accountLabel: `${carrier}-acct-${fakeAccountLast4()}`,
    error: null,
  };
}

export async function sync(_carrier: Carrier): Promise<ProviderSyncResult> {
  // Simulated retrieval. A real implementation would fetch + normalize a
  // bill here and hand it to the extraction pipeline.
  return {
    ok: true,
    syncedAt: new Date().toISOString(),
    error: null,
  };
}
