'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';

export interface ReportActionsProps {
  auditId: string;
  isPublic?: boolean;
}

type ShareState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'copied' }
  | { kind: 'error'; message: string };

interface ShareResponse {
  url: string;
}

function isShareResponse(v: unknown): v is ShareResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.url === 'string' && r.url.length > 0;
}

export function ReportActions({
  auditId,
  isPublic = false,
}: ReportActionsProps): React.JSX.Element {
  const [share, setShare] = React.useState<ShareState>({ kind: 'idle' });
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleShare = React.useCallback(async (): Promise<void> => {
    setShare({ kind: 'loading' });
    try {
      const res = await fetch(`/api/audits/${auditId}/share`, {
        method: 'POST',
      });
      if (!res.ok) {
        setShare({ kind: 'error', message: 'Could not generate link.' });
        return;
      }
      const body: unknown = await res.json();
      if (!isShareResponse(body)) {
        setShare({ kind: 'error', message: 'Invalid response.' });
        return;
      }
      try {
        await navigator.clipboard.writeText(body.url);
      } catch {
        setShare({ kind: 'error', message: 'Could not copy to clipboard.' });
        return;
      }
      setShare({ kind: 'copied' });
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setShare({ kind: 'idle' });
      }, 2000);
    } catch {
      setShare({ kind: 'error', message: 'Could not generate link.' });
    }
  }, [auditId]);

  const handleDownload = React.useCallback((): void => {
    window.open(`/api/audits/${auditId}/report.pdf`, '_blank', 'noopener');
  }, [auditId]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={handleDownload} variant="default">
        Download PDF
      </Button>
      {!isPublic ? (
        <>
          <Button
            onClick={() => {
              void handleShare();
            }}
            variant="outline"
            disabled={share.kind === 'loading'}
          >
            {share.kind === 'loading' ? 'Generating…' : 'Share link'}
          </Button>
          {share.kind === 'copied' ? (
            <span
              className="text-xs font-medium text-emerald-700"
              aria-live="polite"
            >
              Copied!
            </span>
          ) : null}
          {share.kind === 'error' ? (
            <span className="text-xs font-medium text-red-600" aria-live="polite">
              {share.message}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
