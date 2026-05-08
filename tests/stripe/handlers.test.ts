import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

import { handleStripeEvent } from '@/lib/stripe/handlers';

// --- Supabase mock ---------------------------------------------------------
//
// We model the supabase client surface used by handleStripeEvent:
//   - `.from(table).update(patch).eq(col, value)` returning `{ error }`
//   - `.rpc(name, args)` returning `{ error }`

type UpdateCall = { table: string; patch: Record<string, unknown>; eq: [string, unknown] };
type RpcCall = { name: string; args: Record<string, unknown> };

interface MockClient {
  from: (table: string) => unknown;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: null | { message: string } }>;
  __updates: UpdateCall[];
  __rpcs: RpcCall[];
  __nextUpdateError: { message: string } | null;
  __nextRpcError: { message: string } | null;
}

function makeClient(): MockClient {
  const state: MockClient = {
    __updates: [],
    __rpcs: [],
    __nextUpdateError: null,
    __nextRpcError: null,
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          return {
            eq: async (col: string, value: unknown) => {
              state.__updates.push({ table, patch, eq: [col, value] });
              const err = state.__nextUpdateError;
              state.__nextUpdateError = null;
              return { error: err };
            },
          };
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      state.__rpcs.push({ name, args });
      const err = state.__nextRpcError;
      state.__nextRpcError = null;
      return { error: err };
    },
  };
  return state;
}

function makeEvent<T extends Stripe.Event['type']>(
  type: T,
  object: Record<string, unknown>,
): Stripe.Event {
  return {
    id: `evt_${type}`,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

let client: MockClient;

beforeEach(() => {
  client = makeClient();
  vi.clearAllMocks();
});

describe('handleStripeEvent', () => {
  it('checkout.session.completed (payment) increments credits and stores customer id', async () => {
    const event = makeEvent('checkout.session.completed', {
      mode: 'payment',
      client_reference_id: 'user_abc',
      customer: 'cus_111',
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__rpcs).toHaveLength(1);
    expect(client.__rpcs[0]).toEqual({
      name: 'increment_audit_credits',
      args: { profile_id: 'user_abc', delta: 1 },
    });

    // The customer id should also be persisted to the profile.
    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.table).toBe('profiles');
    expect(update?.eq).toEqual(['id', 'user_abc']);
    expect(update?.patch['stripe_customer_id']).toBe('cus_111');
  });

  it('checkout.session.completed (subscription) sets subscription_id + status=active', async () => {
    const event = makeEvent('checkout.session.completed', {
      mode: 'subscription',
      client_reference_id: 'user_xyz',
      customer: 'cus_222',
      subscription: 'sub_777',
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__rpcs).toHaveLength(0);
    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.table).toBe('profiles');
    expect(update?.eq).toEqual(['id', 'user_xyz']);
    expect(update?.patch['subscription_id']).toBe('sub_777');
    expect(update?.patch['subscription_status']).toBe('active');
    expect(update?.patch['stripe_customer_id']).toBe('cus_222');
  });

  it('customer.subscription.updated propagates the new status', async () => {
    const event = makeEvent('customer.subscription.updated', {
      id: 'sub_42',
      customer: 'cus_42',
      status: 'past_due',
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.table).toBe('profiles');
    expect(update?.eq).toEqual(['stripe_customer_id', 'cus_42']);
    expect(update?.patch['subscription_status']).toBe('past_due');
    expect(update?.patch['subscription_id']).toBe('sub_42');
  });

  it('customer.subscription.created stores active status', async () => {
    const event = makeEvent('customer.subscription.created', {
      id: 'sub_new',
      customer: 'cus_new',
      status: 'active',
    });

    await handleStripeEvent(event, client as unknown as never);

    const update = client.__updates[0];
    expect(update?.patch['subscription_status']).toBe('active');
    expect(update?.patch['subscription_id']).toBe('sub_new');
  });

  it('customer.subscription.deleted sets canceled and clears subscription_id', async () => {
    const event = makeEvent('customer.subscription.deleted', {
      id: 'sub_gone',
      customer: 'cus_gone',
      status: 'canceled',
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.eq).toEqual(['stripe_customer_id', 'cus_gone']);
    expect(update?.patch['subscription_status']).toBe('canceled');
    expect(update?.patch['subscription_id']).toBeNull();
  });

  it('invoice.payment_failed marks the profile past_due', async () => {
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_fail',
      customer: 'cus_fail',
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.eq).toEqual(['stripe_customer_id', 'cus_fail']);
    expect(update?.patch['subscription_status']).toBe('past_due');
  });

  it('unknown event types are no-ops', async () => {
    // Cast through unknown — the type system would otherwise reject an
    // unhandled literal.
    const event = {
      id: 'evt_unknown',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1' } },
    } as unknown as Stripe.Event;

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__updates).toHaveLength(0);
    expect(client.__rpcs).toHaveLength(0);
  });

  it('throws when supabase update returns an error', async () => {
    client.__nextUpdateError = { message: 'pg boom' };
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_err',
      customer: 'cus_err',
    });

    await expect(
      handleStripeEvent(event, client as unknown as never),
    ).rejects.toThrow(/past_due update failed/);
  });
});
