'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export interface ReportActionsProps {
  auditId: string;
  isPublic?: boolean;
  /**
   * When the viewer reached the report via a public share link, the download
   * routes need `?token=<share_token>` to authorize the request. Auth users
   * leave this undefined; the cookie does the job.
   */
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

  // The share-token query string used by both download buttons when the
  // viewer arrived via /share/[token]. Empty string for authed callers so
  // the URL stays clean.
  const tokenQuery = shareToken ? `?token=${encodeURIComponent(shareToken)}` : '';

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
    window.open(`/api/audits/${auditId}/report.pdf${tokenQuery}`, '_blank', 'noopener');
  }, [auditId, tokenQuery]);

  const handleDownloadCsv = React.useCallback((): void => {
    window.open(`/api/audits/${auditId}/findings.csv${tokenQuery}`, '_blank', 'noopener');
  }, [auditId, tokenQuery]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={handleDownload} variant="default">
        Download PDF
      </Button>
      <Button onClick={handleDownloadCsv} variant="outline">
        Export CSV
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
