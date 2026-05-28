'use server';

import { revalidatePath } from 'next/cache';

import { authenticate, sync } from '@/lib/carriers/provider';
import { CarrierSchema, type CarrierConnection } from '@/lib/carriers/types';
import { createClient } from '@/lib/supabase/server';

export type CarrierActionResult =
  | { ok: true }
  | { ok: false; error: string };

interface ConnectionRow {
  carrier: string;
  status: string;
  account_label: string | null;
  last_error: string | null;
  last_synced_at: string | null;
}

function toConnection(row: ConnectionRow): CarrierConnection {
  return {
    carrier: row.carrier as CarrierConnection['carrier'],
    status: row.status as CarrierConnection['status'],
    accountLabel: row.account_label,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
  };
}

export async function listConnectionsAction(): Promise<CarrierConnection[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from('carrier_connections')
    .select('carrier, status, account_label, last_error, last_synced_at')
    .eq('user_id', user.id);

  return Array.isArray(data) ? (data as ConnectionRow[]).map(toConnection) : [];
}

export async function connectCarrierAction(
  input: unknown,
): Promise<CarrierActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const parsed = CarrierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Unknown carrier.' };
  const carrier = parsed.data;

  const auth = await authenticate(carrier);
  if (!auth.ok) {
    return { ok: false, error: auth.error ?? 'Carrier authentication failed.' };
  }

  const { error } = await supabase.from('carrier_connections').upsert(
    {
      user_id: user.id,
      carrier,
      status: 'connected',
      account_label: auth.accountLabel,
      last_error: null,
    },
    { onConflict: 'user_id,carrier' },
  );
  if (error) return { ok: false, error: 'Could not save connection.' };

  revalidatePath('/carriers');
  return { ok: true };
}

export async function disconnectCarrierAction(
  input: unknown,
): Promise<CarrierActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const parsed = CarrierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Unknown carrier.' };

  const { error } = await supabase
    .from('carrier_connections')
    .update({
      status: 'disconnected',
      account_label: null,
      last_error: null,
    })
    .eq('user_id', user.id)
    .eq('carrier', parsed.data);
  if (error) return { ok: false, error: 'Could not disconnect.' };

  revalidatePath('/carriers');
  return { ok: true };
}

export async function syncCarrierAction(
  input: unknown,
): Promise<CarrierActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const parsed = CarrierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Unknown carrier.' };
  const carrier = parsed.data;

  const result = await sync(carrier);
  const { error } = await supabase
    .from('carrier_connections')
    .update({
      last_synced_at: result.syncedAt,
      status: result.ok ? 'connected' : 'error',
      last_error: result.error,
    })
    .eq('user_id', user.id)
    .eq('carrier', carrier)
    .eq('status', 'connected');
  if (error) return { ok: false, error: 'Could not sync.' };

  revalidatePath('/carriers');
  return { ok: true };
}
