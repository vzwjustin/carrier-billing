/**
 * Typed analytics event registry. Both client and server trackers consume
 * this — but split into separate modules so importing the client tracker
 * from a client component doesn't drag the posthog-node SDK (which uses
 * `node:readline`) into the browser bundle.
 *
 * PII discipline (CLAUDE.md §1#9): event properties are aggregate metadata
 * only — audit IDs, severities, counts, savings totals. We never include
 * raw bill content, employee names, phone numbers, or account numbers.
 */

export type AnalyticsEvent =
  | {
      name: 'audit_uploaded';
      properties: { auditId: string; carrier?: string; sizeBytes?: number };
    }
  | {
      name: 'audit_completed';
      properties: {
        auditId: string;
        carrier: string;
        finding_count: number;
        high_severity_count: number;
        estimated_monthly_savings_cents: number;
      };
    }
  | {
      name: 'report_viewed';
      properties: { auditId: string; isPublic: boolean };
    }
  | {
      name: 'report_pdf_downloaded';
      properties: { auditId: string; isPublic: boolean };
    }
  | {
      name: 'report_shared';
      properties: { auditId: string };
    }
  | {
      name: 'checkout_started';
      properties: { mode: 'one_time' | 'subscription' };
    }
  | {
      name: 'checkout_completed';
      properties: { mode: 'one_time' | 'subscription'; userId: string };
    };

// Re-exports preserve the original import shape for any module using
// `import { trackClient, trackServer } from '@/lib/analytics/events'`.
// The split modules avoid the bundler dragging server-only deps into the
// browser when only `trackClient` is needed.
export { trackClient } from './client';
export { trackServer } from './server';
