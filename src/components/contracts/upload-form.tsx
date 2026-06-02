'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dropzone } from '@/components/upload/dropzone';

type Phase = 'idle' | 'preparing' | 'uploading' | 'starting' | 'redirecting';

interface CreateContractResponse {
  contractId: string;
  uploadUrl: string;
  storagePath: string;
  token: string;
}

function isCreateContractResponse(value: unknown): value is CreateContractResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.contractId === 'string' &&
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
  starting: 'Starting extraction…',
  redirecting: 'Opening contract…',
};

export function ContractUploadForm(): React.JSX.Element {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');

  const busy = phase !== 'idle';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || busy) return;

    try {
      setPhase('preparing');
      const createRes = await fetch('/api/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, size_bytes: file.size }),
      });
      const createBody: unknown = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        throw new Error(extractError(createBody, 'Failed to create contract.'));
      }
      if (!isCreateContractResponse(createBody)) {
        throw new Error('Unexpected response from server.');
      }
      const { contractId, uploadUrl } = createBody;

      setPhase('uploading');
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (${putRes.status}). Please try again.`);
      }

      setPhase('starting');
      const startRes = await fetch(`/api/contracts/${contractId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const startBody: unknown = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        throw new Error(extractError(startBody, 'Failed to start extraction.'));
      }

      setPhase('redirecting');
      router.push(`/contracts/${contractId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed.';
      toast.error(message);
      setPhase('idle');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Dropzone onFile={setFile} disabled={busy} />

      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500" aria-live="polite">
          {phase === 'idle' ? '' : PHASE_COPY[phase]}
        </p>
        <Button type="submit" size="lg" disabled={!file || busy}>
          {busy ? 'Working…' : 'Extract contract'}
        </Button>
      </div>
    </form>
  );
}
