import * as React from 'react';

import { BillSummary } from '@/components/report/bill-summary';
import { ExtractionConfidenceBanner } from '@/components/report/extraction-confidence-banner';
import { FindingsList } from '@/components/report/findings-list';
import { ReportActions } from '@/components/report/report-actions';
import { SavingsHero } from '@/components/report/savings-hero';
import type { ReportData } from '@/reports/types';

export interface ReportViewProps {
  report: ReportData;
  isPublic?: boolean;
  /**
   * Passed through to `ReportActions` so the PDF / CSV download buttons
   * append `?token=…` when the viewer arrived via a public share link. The
   * download routes accept either an auth cookie or a share token; without
   * one of the two they 401, which would make the buttons broken on /share.
   */
  shareToken?: string;
}

export function ReportView({
  report,
  isPublic = false,
  shareToken,
}: ReportViewProps): React.JSX.Element {
  return (
    <div className="space-y-6">
      <ExtractionConfidenceBanner confidence={report.audit.extraction_confidence} />
      <SavingsHero audit={report.audit} />
      <ReportActions auditId={report.audit.id} isPublic={isPublic} shareToken={shareToken} />
      <BillSummary audit={report.audit} />
      <FindingsList
        findingsBySeverity={report.findingsBySeverity}
        totalFindingCount={report.audit.finding_count}
        auditId={report.audit.id}
        isPublic={isPublic}
      />
    </div>
  );
}
