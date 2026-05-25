/**
 * M11: Zod schemas for every Inngest event payload.
 *
 * The Inngest client (`./client.ts`) declares event shapes as TypeScript
 * types only. That's fine at the producer (`inngest.send`) site — the
 * compiler enforces shape at the call site — but it gives zero runtime
 * guarantee on the consumer side. A future SDK bump, a manually-triggered
 * replay, or a producer in a different deploy can deliver a payload that
 * passes the type cast and explodes deep in the handler.
 *
 * These schemas are the consumer-side contract. Each Inngest function
 * should parse `event.data` through the matching schema at its first
 * `step.run` boundary so a bad payload fails closed with a clear error
 * rather than a `Cannot read property` deep inside a step.
 */
import { z } from 'zod';

export const BillUploadedDataSchema = z.object({
  auditId: z.string().uuid(),
  userId: z.string().uuid(),
  storagePath: z.string().min(1),
});
export type BillUploadedData = z.infer<typeof BillUploadedDataSchema>;

export const AuditCompletedDataSchema = z.object({
  auditId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type AuditCompletedData = z.infer<typeof AuditCompletedDataSchema>;

export const BillingPaymentFailedDataSchema = z.object({
  userId: z.string().uuid(),
  stripeCustomerId: z.string().min(1),
  invoiceId: z.string().nullable(),
  amountDueCents: z.number().int().nullable(),
});
export type BillingPaymentFailedData = z.infer<
  typeof BillingPaymentFailedDataSchema
>;

export const ContractUploadedDataSchema = z.object({
  contractId: z.string().uuid(),
  userId: z.string().uuid(),
  storagePath: z.string().min(1),
});
export type ContractUploadedData = z.infer<typeof ContractUploadedDataSchema>;

// FindingStatus values mirror the CHECK constraint in
// supabase/migrations/0023_finding_status_workflow.sql and the literal union
// at src/rules/types.ts. Repeated here as a tuple so the schema can validate
// without importing types from a 'use client'-adjacent module.
export const FINDING_STATUS_ENUM = [
  'new',
  'in_review',
  'approved',
  'rejected',
  'disputed',
  'resolved',
] as const;

export const FindingStatusChangedDataSchema = z.object({
  auditId: z.string().uuid(),
  findingId: z.string().uuid(),
  status: z.enum(FINDING_STATUS_ENUM),
  // null when the previous value is unknown (e.g. defensive write where the
  // pre-image SELECT failed). Receivers should treat null as "indeterminate".
  previousStatus: z.enum(FINDING_STATUS_ENUM).nullable(),
  userId: z.string().uuid(),
});
export type FindingStatusChangedData = z.infer<
  typeof FindingStatusChangedDataSchema
>;

/**
 * Severity domain mirrors `findings.severity` CHECK in migration 0001.
 * Repeated as a tuple here so the schema can validate without importing
 * the type-only enum module (Zod needs runtime literals).
 */
export const FINDING_SEVERITY_ENUM = [
  'high',
  'medium',
  'low',
  'info',
] as const;

export const FindingCreatedDataSchema = z.object({
  auditId: z.string().uuid(),
  findingId: z.string().uuid(),
  userId: z.string().uuid(),
  severity: z.enum(FINDING_SEVERITY_ENUM),
  // rule_id is a stable identifier (e.g. "autopsy_escalated_<category>") —
  // bounded to a sane length so a misconfigured caller can't push an
  // unbounded string into Inngest event history.
  ruleId: z.string().min(1).max(120),
  title: z.string().min(1).max(500),
  estimatedMonthlySavingsCents: z.number().int().nullable(),
});
export type FindingCreatedData = z.infer<typeof FindingCreatedDataSchema>;

export const BillComparisonPersistedDataSchema = z.object({
  comparisonId: z.string().uuid(),
  userId: z.string().uuid(),
  previousAuditId: z.string().uuid(),
  currentAuditId: z.string().uuid(),
  disputableCents: z.number().int(),
  netChangeCents: z.number().int(),
  driversCount: z.number().int().min(0),
});
export type BillComparisonPersistedData = z.infer<
  typeof BillComparisonPersistedDataSchema
>;

/**
 * Convenience: parse + throw with a stable error name so the Inngest
 * function's top-level catch can surface the event shape issue distinctly
 * from any other error in the pipeline.
 */
export class InngestEventValidationError extends Error {
  constructor(eventName: string, issues: z.ZodIssue[]) {
    const summary = issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    super(`Invalid '${eventName}' event payload: ${summary}`);
    this.name = 'InngestEventValidationError';
  }
}

export function parseEventData<T>(
  eventName: string,
  data: unknown,
  schema: z.ZodType<T>,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new InngestEventValidationError(eventName, result.error.issues);
  }
  return result.data;
}
