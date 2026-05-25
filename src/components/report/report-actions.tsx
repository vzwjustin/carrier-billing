'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export interface ReportActionsProps {
  auditId: string;
  isPublic?: boolean;
  shareToken?: string;
}

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
  shareToken,
}: ReportActionsProps): React.JSX.Element {
  const [isLoading, setIsLoading] = React.useState(false);

  const handleShare = React.useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/audits/${auditId}/share`, {
        method: 'POST',
      });
      if (!res.ok) {
        toast.error('Could not generate link.');
        return;
      }
      const body: unknown = await res.json();
      if (!isShareResponse(body)) {
        toast.error('Invalid response.');
        return;
      }
      try {
        await navigator.clipboard.writeText(body.url);
      } catch {
        toast.error('Could not copy to clipboard.');
        return;
      }
      toast.success('Link copied');
    } catch {
      toast.error('Could not generate link.');
    } finally {
      setIsLoading(false);
    }
  }, [auditId]);

  const handleDownload = React.useCallback((): void => {
    const tokenQuery =
      isPublic && shareToken
        ? `?token=${encodeURIComponent(shareToken)}`
        : '';
    window.open(`/api/audits/${auditId}/report.pdf${tokenQuery}`, '_blank', 'noopener');
  }, [auditId, isPublic, shareToken]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={handleDownload} variant="default">
        Download PDF
      </Button>
      {!isPublic ? (
        <Button
          onClick={() => {
            void handleShare();
          }}
          variant="outline"
          disabled={isLoading}
        >
          {isLoading ? 'Generating…' : 'Share link'}
        </Button>
      ) : null}
    </div>
  );
}
