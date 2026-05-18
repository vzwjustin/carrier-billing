import { z } from 'zod';

import { CarrierSchema } from './types';

// Money is integer cents everywhere, consistent with the rest of the schema.
export const LineItemSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().trim().min(1).max(160),
  monthlyCents: z.number().int().min(0).max(100_000_00),
  optimizedCents: z.number().int().min(0).max(100_000_00),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const SaveBillSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(120),
  lineItems: z.array(LineItemSchema).max(200),
});

export const CreateBillSchema = z.object({
  carrier: CarrierSchema,
  label: z.string().trim().min(1).max(120),
});

export interface CarrierBill {
  id: string;
  carrier: z.infer<typeof CarrierSchema>;
  label: string;
  lineItems: LineItem[];
  updatedAt: string;
}

export interface BillTotals {
  currentCents: number;
  optimizedCents: number;
  savingsCents: number;
}

export function billTotals(lineItems: LineItem[]): BillTotals {
  let currentCents = 0;
  let optimizedCents = 0;
  for (const li of lineItems) {
    currentCents += li.monthlyCents;
    optimizedCents += li.optimizedCents;
  }
  return {
    currentCents,
    optimizedCents,
    savingsCents: currentCents - optimizedCents,
  };
}
