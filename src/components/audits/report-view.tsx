import * as React from 'react';

import { BillSummary } from '@/components/report/bill-summary';
import { FindingsList } from '@/components/report/findings-list';
import { ReportActions } from '@/components/report/report-actions';
import { SavingsHero } from '@/components/report/savings-hero';
import type { ReportData } from '@/reports/types';

export interface ReportViewProps {
  report: ReportData;
  isPublic?: boolean;
}

export function ReportView({
  report,
  isPublic = false,
}: ReportViewProps): React.JSX.Element {
  return (
    <div className="space-y-6">
      <SavingsHero audit={report.audit} />
      <ReportActions auditId={report.audit.id} isPublic={isPublic} />
      <BillSummary audit={report.audit} />
      <FindingsList
        findingsBySeverity={report.findingsBySeverity}
        totalFindingCount={report.audit.finding_count}
      />
    </div>
  );
}
