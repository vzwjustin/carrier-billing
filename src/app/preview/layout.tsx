/**
 * /preview/* — dev-only visual showcase for the new SignalAudit-era
 * components, rendered with realistic fixture data.
 *
 * These pages exist so you can screenshot the actual UI components
 * without spinning up Supabase + auth + a real audit. They mount the
 * SAME React components used in production (`AutopsyClient`,
 * `FindingCard`, `ReportView`) — only the data is mocked.
 *
 * NOT linked from nav. NOT protected (intentionally — they don't read
 * any user data). Safe to leave in for now; remove once a real demo
 * fixture/seed lands.
 */
import type { ReactNode } from 'react';

import '@/app/globals.css';

export const metadata = { title: 'Preview — CarrierAudit' };

export default function PreviewLayout({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="border-b border-neutral-200 bg-amber-50">
        <div className="mx-auto max-w-7xl px-6 py-2 text-xs text-amber-900">
          <strong>Preview mode</strong> — these pages render production components
          with fixture data so the UI can be screenshotted without a logged-in
          session or real audit data. Not linked from the app.
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-6 py-8">{children}</div>
    </div>
  );
}
