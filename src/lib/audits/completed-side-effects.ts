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
  /**
   * process-bill wraps analytics, trail, and Inngest send in step.run so
   * replays do not double-emit PostHog events or audit-trail rows.
   */
  runInStep?: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
}): Promise<void> {
  const {
    auditId,
    userId,
    carrier,
    findingCount,
    highSeverityCount,
    monthlySavingsCents,
    logger,
    runInStep,
  } = opts;

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    if (runInStep) {
      await runInStep(name, async () => {
        await fn();
        return { ok: true };
      });
      return;
    }
    await fn();
  };

  await run('track-completed', async () => {
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
        message: analyticsErr instanceof Error ? analyticsErr.message : 'unknown analytics error',
      });
    }
  });

  await run('log-trail-completed', async () => {
    try {
      await logTrailEvent({
        userId,
        eventType: 'audit_completed',
        entityType: 'audit',
        entityId: auditId,
        metadata: { carrier: carrier ?? 'unknown', finding_count: findingCount },
      });
    } catch (trailErr) {
      logger?.error('dispatchAuditCompletedSideEffects: logTrailEvent failed', {
        auditId,
        message: trailErr instanceof Error ? trailErr.message : 'unknown trail error',
      });
    }
  });

  try {
    await run('send-trigger', async () => {
      await inngest.send({
        id: `${auditId}-completed`,
        name: 'audit.completed',
        data: { auditId, userId },
      });
    });
  } catch (sendErr) {
    logger?.error('dispatchAuditCompletedSideEffects: audit.completed send failed', {
      auditId,
      userId,
      message: sendErr instanceof Error ? sendErr.message : 'unknown send error',
    });
  }
}
