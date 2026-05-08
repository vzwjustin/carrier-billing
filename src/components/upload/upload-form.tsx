'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dropzone } from '@/components/upload/dropzone';

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

export function UploadForm(): React.JSX.Element {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [error, setError] = React.useState<string | null>(null);

  const busy = phase !== 'idle';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || busy) return;
    setError(null);

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

      // Step 2: upload PDF to signed URL.
      setPhase('uploading');
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
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

      // Step 4: redirect.
      setPhase('redirecting');
      router.push(`/audits/${auditId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      setError(message);
      setPhase('idle');
    }
  };

  const handleReset = () => {
    setError(null);
    setPhase('idle');
  };

  if (error) {
    return (
      <div className="space-y-4 rounded-lg border border-red-200 bg-red-50 p-6">
        <div>
          <h2 className="text-base font-medium text-red-900">
            Something went wrong
          </h2>
          <p className="mt-1 text-sm text-red-800">{error}</p>
        </div>
        <Button type="button" variant="outline" onClick={handleReset}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Dropzone onFile={setFile} disabled={busy} />

      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500" aria-live="polite">
          {phase === 'idle' ? '' : PHASE_COPY[phase]}
        </p>
        <Button type="submit" size="lg" disabled={!file || busy}>
          {busy ? 'Working…' : 'Run audit'}
        </Button>
      </div>
    </form>
  );
}
