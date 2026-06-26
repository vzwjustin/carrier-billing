'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  autoMap,
  CANONICAL_FIELDS,
  type CanonicalField,
  type ColumnMapping,
} from '@/extraction/csv/mapping';
import { parseCsvRows } from '@/extraction/csv/parse';

/**
 * Three-step CSV import wizard:
 *   1. Pick a file (.csv, ≤ 5 MB).
 *   2. Preview headers + auto-mapped column picks; let the user override.
 *   3. POST the mapping; on success redirect to /audits/[id].
 *
 * The file is parsed CLIENT-SIDE just for preview / header detection. The
 * authoritative parse runs server-side in /process — so a malicious user
 * can't bypass validation by editing local state.
 */

type Phase =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'previewing'
  | 'awaitingMapping'
  | 'processing'
  | 'redirecting';

const PHASE_COPY: Record<Exclude<Phase, 'idle' | 'awaitingMapping'>, string> = {
  preparing: 'Preparing…',
  uploading: 'Uploading…',
  previewing: 'Reading headers…',
  processing: 'Running audit…',
  redirecting: 'Opening audit…',
};

function phaseLabel(phase: Phase): string {
  if (phase === 'idle' || phase === 'awaitingMapping') return '';
  return PHASE_COPY[phase];
}

const CANONICAL_LABELS: Record<CanonicalField, string> = {
  mdn_last4: 'Phone number',
  user_label: 'User / line label',
  device: 'Device',
  plan_name: 'Plan name',
  plan_base_cents: 'Monthly plan charge',
  data_used_gb: 'Data used (GB)',
  voice_used_min: 'Voice minutes used',
  sms_used_count: 'SMS count',
  is_suspended: 'Suspended flag',
  account_number_last4: 'Account number',
  account_label: 'Account label',
};

const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_LINE_LIMIT = 200;

interface CreateAuditResponse {
  auditId: string;
  uploadUrl: string;
  storagePath: string;
}
function isCreateAuditResponse(value: unknown): value is CreateAuditResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.auditId === 'string' &&
    typeof v.uploadUrl === 'string' &&
    typeof v.storagePath === 'string'
  );
}

function extractError(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v.error === 'string') return v.error;
    if (typeof v.message === 'string') return v.message;
  }
  return fallback;
}

/**
 * Read up to PREVIEW_LINE_LIMIT lines from a CSV File. We read the whole
 * file (it's ≤ 5MB) and slice at newline boundaries — safer than chunked
 * reading because a quoted cell can legally span multiple lines and we
 * don't want to truncate inside one.
 */
async function readPreview(file: File): Promise<{
  headers: string[];
  sampleRows: string[][];
}> {
  const text = await file.text();
  // Cheap upper bound on lines; the parser still enforces a cell-count cap.
  const lines = text.split(/\r?\n/).slice(0, PREVIEW_LINE_LIMIT + 1);
  const truncated = lines.join('\n');
  const rows = parseCsvRows(truncated);
  if (rows.length === 0) {
    return { headers: [], sampleRows: [] };
  }
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const sampleRows = rows.slice(1).slice(0, 5);
  return { headers, sampleRows };
}

export function CsvImportWizard(): React.JSX.Element {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [auditId, setAuditId] = React.useState<string | null>(null);
  const [headers, setHeaders] = React.useState<string[] | null>(null);
  const [mapping, setMapping] = React.useState<ColumnMapping>({});
  const inputRef = React.useRef<HTMLInputElement>(null);

  const busy = phase !== 'idle' && phase !== 'awaitingMapping';

  const handlePickFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    if (!/\.csv$/i.test(picked.name)) {
      toast.error('Only .csv files are accepted.');
      return;
    }
    if (picked.size > MAX_BYTES) {
      toast.error('File is too large. Maximum size is 5 MB.');
      return;
    }
    if (picked.size === 0) {
      toast.error('File appears to be empty.');
      return;
    }
    setFile(picked);
  };

  const handleUpload = async (): Promise<void> => {
    if (!file || busy) return;
    try {
      setPhase('preparing');
      const createRes = await fetch('/api/audits/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, size_bytes: file.size }),
      });
      const createBody: unknown = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        throw new Error(extractError(createBody, 'Failed to create audit.'));
      }
      if (!isCreateAuditResponse(createBody)) {
        throw new Error('Unexpected response from server.');
      }
      const { auditId: newAuditId, uploadUrl } = createBody;

      setPhase('uploading');
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (${putRes.status}). Please try again.`);
      }

      setPhase('previewing');
      const preview = await readPreview(file);
      if (preview.headers.length === 0) {
        throw new Error('CSV appears to be empty or unreadable.');
      }
      const guessed = autoMap(preview.headers);
      setAuditId(newAuditId);
      setHeaders(preview.headers);
      setMapping(guessed);
      setPhase('awaitingMapping');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      toast.error(message);
      setPhase('idle');
    }
  };

  const handleMappingChange = (field: CanonicalField, value: string): void => {
    setMapping((prev) => ({
      ...prev,
      [field]: value === '' ? null : value,
    }));
  };

  const handleProcess = async (): Promise<void> => {
    if (!auditId || busy) return;
    try {
      setPhase('processing');
      const res = await fetch(`/api/audits/csv/${auditId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(extractError(body, 'Failed to run audit.'));
      }
      setPhase('redirecting');
      router.push(`/audits/${auditId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Audit failed.';
      toast.error(message);
      setPhase('awaitingMapping');
    }
  };

  // Step 1 — file picker. Reached when we haven't yet pulled headers OR
  // we're still in the initial state. `awaitingMapping` implies headers
  // are populated, so this guard naturally falls through to step 2.
  if (!headers || phase === 'idle') {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border-2 border-dashed border-neutral-300 bg-white p-12 text-center">
          <p className="text-sm font-medium text-neutral-900">Upload a carrier CSV export</p>
          <p className="mt-1 text-xs text-neutral-500">
            Verizon, AT&amp;T, or T-Mobile line-detail CSV, up to 5 MB.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handlePickFile}
            disabled={busy}
          />
          <div className="mt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              Choose CSV
            </Button>
          </div>
          {file ? <p className="mt-3 text-sm text-neutral-900">{file.name}</p> : null}
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm text-neutral-500" aria-live="polite">
            {phaseLabel(phase)}
          </p>
          <Button type="button" size="lg" disabled={!file || busy} onClick={handleUpload}>
            {busy ? 'Working…' : 'Upload + continue'}
          </Button>
        </div>
      </div>
    );
  }

  // Step 2 — column mapping.
  const safeHeaders = headers ?? [];
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">Map your columns</h2>
        <p className="mt-1 text-sm text-neutral-500">
          We auto-detected the best column for each field. Override any dropdown that looks wrong.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <table className="w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50">
            <tr>
              <th scope="col" className="px-4 py-2 text-left font-medium text-neutral-700">
                Field
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium text-neutral-700">
                CSV column
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {CANONICAL_FIELDS.map((field) => {
              const current = mapping[field] ?? '';
              return (
                <tr key={field}>
                  <td className="px-4 py-2 font-medium text-neutral-900">
                    {CANONICAL_LABELS[field]}
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={current}
                      onChange={(e) => handleMappingChange(field, e.target.value)}
                      className="block w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                      disabled={busy}
                    >
                      <option value="">— Not mapped —</option>
                      {safeHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500" aria-live="polite">
          {phaseLabel(phase)}
        </p>
        <Button type="button" size="lg" onClick={handleProcess} disabled={busy}>
          {busy ? 'Working…' : 'Run audit'}
        </Button>
      </div>
    </div>
  );
}
