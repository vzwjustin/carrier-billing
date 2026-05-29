'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dropzone } from '@/components/upload/dropzone';
import { trackClient } from '@/lib/analytics/client';

type Phase = 'idle' | 'preparing' | 'uploading' | 'starting' | 'redirecting';

interface CreateAuditResponse {
  auditId: string;
  uploadUrl: string;
  storagePath: string;
  token: string;
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

const PHASE_COPY: Record<Exclude<Phase, 'idle'>, string> = {
  preparing: 'Preparing…',
  uploading: 'Uploading…',
  starting: 'Starting analysis…',
  redirecting: 'Opening audit…',
};

const PHASE_ORDER: ReadonlyArray<Exclude<Phase, 'idle'>> = [
  'preparing',
  'uploading',
  'starting',
  'redirecting',
];

function PhaseIndicator({ phase }: { phase: Phase }): React.JSX.Element | null {
  if (phase === 'idle') return null;
  const activeIndex = PHASE_ORDER.indexOf(phase);
  return (
    <div
      className="mt-4 flex items-center gap-2 text-xs text-neutral-600"
      aria-live="polite"
    >
      {PHASE_ORDER.map((p, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <React.Fragment key={p}>
            <div className="flex items-center gap-1.5">
              <span
                className={
                  done
                    ? 'flex h-4 w-4 items-center justify-center rounded-full bg-neutral-900 text-[10px] text-white'
                    : active
                      ? 'flex h-4 w-4 items-center justify-center rounded-full bg-neutral-900 text-[10px] text-white'
                      : 'flex h-4 w-4 items-center justify-center rounded-full border border-neutral-300 text-[10px] text-neutral-400'
                }
                aria-hidden="true"
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={
                  active
                    ? 'font-medium text-neutral-900'
                    : done
                      ? 'text-neutral-500'
                      : 'text-neutral-400'
                }
              >
                {PHASE_COPY[p].replace('…', '')}
              </span>
            </div>
            {i < PHASE_ORDER.length - 1 ? (
              <span className="h-px w-4 bg-neutral-200" aria-hidden="true" />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function UploadForm(): React.JSX.Element {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');

  const busy = phase !== 'idle';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || busy) return;

    try {
      // Step 1: create audit + signed upload URL.
      setPhase('preparing');
      const createRes = await fetch('/api/audits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, fileSize: file.size }),
      });
      const createBody: unknown = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        throw new Error(extractError(createBody, 'Failed to create audit.'));
      }
      if (!isCreateAuditResponse(createBody)) {
        throw new Error('Unexpected response from server.');
      }
      const { auditId, uploadUrl } = createBody;

      // Step 2: upload to signed URL. EDI 811 files are 7-bit ASCII; we send
      // them as text/plain so Supabase Storage doesn't reject the PUT for a
      // mismatched declared content-type.
      setPhase('uploading');
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': isPdf ? 'application/pdf' : 'text/plain' },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (${putRes.status}). Please try again.`);
      }

      // Step 3: trigger Inngest extraction pipeline.
      setPhase('starting');
      const startRes = await fetch(`/api/audits/${auditId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const startBody: unknown = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        throw new Error(extractError(startBody, 'Failed to start analysis.'));
      }

      // Phase 5 analytics: fire `audit_uploaded` once the audit row exists
      // and the pipeline has been kicked off, but BEFORE the redirect so the
      // event has a chance to flush.
      trackClient({
        name: 'audit_uploaded',
        properties: { auditId, sizeBytes: file.size },
      });

      // Step 4: redirect.
      setPhase('redirecting');
      router.push(`/audits/${auditId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      toast.error(message);
      setPhase('idle');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Dropzone onFile={setFile} disabled={busy} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-neutral-500" aria-live="polite">
            {phase === 'idle' ? '' : PHASE_COPY[phase]}
          </p>
          <Button type="submit" size="lg" disabled={!file || busy}>
            {busy ? 'Working…' : 'Run audit'}
          </Button>
        </div>
        <PhaseIndicator phase={phase} />
      </div>
    </form>
  );
}
