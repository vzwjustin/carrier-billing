'use server';

import { revalidatePath } from 'next/cache';

import {
  CreateBillSchema,
  LineItemSchema,
  SaveBillSchema,
  type CarrierBill,
  type LineItem,
} from '@/lib/carriers/bill-schema';
import type { Carrier } from '@/lib/carriers/types';
import { createClient } from '@/lib/supabase/server';

export type BillActionResult =
  | { ok: true }
  | { ok: false; error: string };

export type CreateBillResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

interface BillRow {
  id: string;
  carrier: string;
  label: string;
  line_items: unknown;
  updated_at: string;
}

function parseLineItems(value: unknown): LineItem[] {
  if (!Array.isArray(value)) return [];
  const out: LineItem[] = [];
  for (const raw of value) {
    const parsed = LineItemSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function toBill(row: BillRow): CarrierBill {
  return {
    id: row.id,
    carrier: row.carrier as Carrier,
    label: row.label,
    lineItems: parseLineItems(row.line_items),
    updatedAt: row.updated_at,
  };
}

export async function listBillsAction(): Promise<CarrierBill[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from('carrier_bills')
    .select('id, carrier, label, line_items, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  return Array.isArray(data) ? (data as BillRow[]).map(toBill) : [];
}

export async function createBillAction(
  input: unknown,
): Promise<CreateBillResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const parsed = CreateBillSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid bill.' };

  const { data, error } = await supabase
    .from('carrier_bills')
    .insert({
      user_id: user.id,
      carrier: parsed.data.carrier,
      label: parsed.data.label,
      line_items: [],
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: 'Could not create bill.' };
  revalidatePath('/carriers/bills');
  return { ok: true, id: (data as { id: string }).id };
}

export async function saveBillAction(
  input: unknown,
): Promise<BillActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const parsed = SaveBillSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid bill data.' };
  }

  const { error } = await supabase
    .from('carrier_bills')
    .update({
      label: parsed.data.label,
      line_items: parsed.data.lineItems,
    })
    .eq('id', parsed.data.id)
    .eq('user_id', user.id);

  if (error) return { ok: false, error: 'Could not save bill.' };
  revalidatePath('/carriers/bills');
  return { ok: true };
}

export async function deleteBillAction(
  input: unknown,
): Promise<BillActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'Invalid bill id.' };
  }

  const { error } = await supabase
    .from('carrier_bills')
    .delete()
    .eq('id', input)
    .eq('user_id', user.id);

  if (error) return { ok: false, error: 'Could not delete bill.' };
  revalidatePath('/carriers/bills');
  return { ok: true };
}
