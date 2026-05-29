import { inngest } from '@/inngest/client';
import { trackServer } from '@/lib/analytics/events';
import { logTrailEvent } from '@/lib/audit-trail/log';

export type CompletedSideEffectsLogger = {
  error: (message: string, ctx?: Record<string, unknown>) => void;
};

/**
 * Post-completion notifications shared by the PDF Inngest worker and the
 * synchronous CSV process route: analytics, audit trail, and the
 * `audit.completed` email trigger.
 */
export async function dispatchAuditCompletedSideEffects(opts: {
  auditId: string;
  userId: string;
  carrier: string | null;
  findingCount: number;
  highSeverityCount: number;
  monthlySavingsCents: number;
  logger?: CompletedSideEffectsLogger;
  /** process-bill wraps the Inngest send in step.run for durability. */
  wrapInngestSend?: (send: () => Promise<void>) => Promise<void>;
}): Promise<void> {
  const {
    auditId,
    userId,
    carrier,
    findingCount,
    highSeverityCount,
    monthlySavingsCents,
    logger,
    wrapInngestSend,
  } = opts;

  try {
    await trackServer(
      {
        name: 'audit_completed',
        properties: {
          auditId,
          carrier: carrier ?? 'unknown',
          finding_count: findingCount,
          high_severity_count: highSeverityCount,
          estimated_monthly_savings_cents: monthlySavingsCents,
        },
      },
      userId,
    );
  } catch (analyticsErr) {
    logger?.error('dispatchAuditCompletedSideEffects: trackServer failed', {
      auditId,
      message:
        analyticsErr instanceof Error
          ? analyticsErr.message
          : 'unknown analytics error',
    });
  }

  await logTrailEvent({
    userId,
    eventType: 'audit_completed',
    entityType: 'audit',
    entityId: auditId,
    metadata: { carrier: carrier ?? 'unknown', finding_count: findingCount },
  });

  const sendCompleted = async () => {
    await inngest.send({
      id: `${auditId}-completed`,
      name: 'audit.completed',
      data: { auditId, userId },
    });
  };

  try {
    if (wrapInngestSend) {
      await wrapInngestSend(sendCompleted);
    } else {
      await sendCompleted();
    }
  } catch (sendErr) {
    logger?.error(
      'dispatchAuditCompletedSideEffects: audit.completed send failed',
      {
        auditId,
        userId,
        message:
          sendErr instanceof Error ? sendErr.message : 'unknown send error',
      },
    );
  }
}
