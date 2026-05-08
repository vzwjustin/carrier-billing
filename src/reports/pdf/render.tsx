/**
 * Server-only entry point that renders a `ReportData` into a PDF Buffer.
 *
 * Kept in its own module so the @react-pdf/renderer dependency is only
 * pulled into route handlers that actually generate PDFs (via dynamic
 * import inside the route).
 */
import 'server-only';

import { renderToBuffer } from '@react-pdf/renderer';

import type { ReportData } from '@/reports/types';

import { ReportDocument } from './document';

export async function renderReportPdf(report: ReportData): Promise<Buffer> {
  return renderToBuffer(<ReportDocument report={report} />);
}
