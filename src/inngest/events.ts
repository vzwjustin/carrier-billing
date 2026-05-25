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
  retryCount: z.number().int().nonnegative().default(0),
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
