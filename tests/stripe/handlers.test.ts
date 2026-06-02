import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const { inngestSendMock } = vi.hoisted(() => ({
  inngestSendMock: vi.fn(async () => ({ ids: ['evt_x'] })),
}));
vi.mock('@/inngest/client', () => ({
  inngest: { send: inngestSendMock },
}));

import { handleStripeEvent } from '@/lib/stripe/handlers';

// --- Supabase mock ---------------------------------------------------------
//
// We model the supabase client surface used by handleStripeEvent:
//   - `.from(table).select(cols).eq(col, value)`           → `{ data, error }`
//     (H9: subscription handlers SELECT current state before UPDATE.)
//   - `.from(table).update(patch).eq(col, value)`           → `{ error }`
//   - `.from(table).update(patch).eq(col, value).select(c)` → `{ data, error }`
//     (B7 fix: payment-failed handler verifies exactly one row.)
//   - `.from(table).update(patch).eq(col, value).or(expr).select(c)` →
//     `{ data, error }`
//     (H4 fix: subscription handlers + invoice.payment_failed use a CAS
//     UPDATE whose WHERE clause re-checks the ordering guard.)
//   - `.rpc(name, args)`                                    → `{ error }`
//
// `__nextUpdateRows` controls what `.update().eq()(.or)?.select(...)` returns.
// `__nextSelectRows` controls what `.select(cols).eq(col, val)` returns.
// Both default to a single matching row so happy-path tests stay terse.
// Each `.or(...)` invocation is recorded on the matching UpdateCall so tests
// can assert the CAS guard expression text was passed through.

type UpdateCall = {
  table: string;
  patch: Record<string, unknown>;
  eq: [string, unknown];
  select?: string;
  or?: string;
};
type SelectCall = {
  table: string;
  cols: string;
  eq: [string, unknown];
};
type RpcCall = { name: string; args: Record<string, unknown> };

interface MockClient {
  from: (table: string) => unknown;
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ error: null | { message: string } }>;
  __updates: UpdateCall[];
  __selects: SelectCall[];
  __rpcs: RpcCall[];
  __nextUpdateError: { message: string } | null;
  __nextSelectError: { message: string } | null;
  __nextRpcError: { message: string } | null;
  __nextUpdateRows:
    | Array<Record<string, unknown>>
    | (() => Array<Record<string, unknown>>)
    | null;
  __nextSelectRows:
    | Array<Record<string, unknown>>
    | (() => Array<Record<string, unknown>>)
    | null;
}

function makeClient(): MockClient {
  const state: MockClient = {
    __updates: [],
    __selects: [],
    __rpcs: [],
    __nextUpdateError: null,
    __nextSelectError: null,
    __nextRpcError: null,
    __nextUpdateRows: null,
    __nextSelectRows: null,
    from(table: string) {
      return {
        select(cols: string) {
          return {
            eq(col: string, value: unknown) {
              const eqArgs: [string, unknown] = [col, value];
              return {
                then(
                  resolve: (v: {
                    data: Array<Record<string, unknown>>;
                    error: typeof state.__nextSelectError;
                  }) => void,
                ) {
                  state.__selects.push({ table, cols, eq: eqArgs });
                  const error = state.__nextSelectError;
                  state.__nextSelectError = null;
                  const next = state.__nextSelectRows;
                  state.__nextSelectRows = null;
                  let rows: Array<Record<string, unknown>>;
                  if (typeof next === 'function') rows = next();
                  else rows = next ?? [{ id: 'profile_default' }];
                  resolve({ data: error ? [] : rows, error });
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          const recordCall = (
            eq: [string, unknown],
            select?: string,
            or?: string,
          ) => {
            state.__updates.push({ table, patch, eq, select, or });
          };
          const consumeRows = (): Array<Record<string, unknown>> => {
            const next = state.__nextUpdateRows;
            state.__nextUpdateRows = null;
            if (typeof next === 'function') return next();
            return next ?? [{ id: 'profile_default' }];
          };
          const consumeError = () => {
            const err = state.__nextUpdateError;
            state.__nextUpdateError = null;
            return err;
          };
          return {
            eq(col: string, value: unknown) {
              const eqArgs: [string, unknown] = [col, value];
              const directThenable = {
                then(
                  resolve: (v: { error: typeof state.__nextUpdateError }) => void,
                ) {
                  recordCall(eqArgs);
                  resolve({ error: consumeError() });
                },
                select(cols: string) {
                  return {
                    then(
                      resolve: (v: {
                        data: Array<Record<string, unknown>>;
                        error: typeof state.__nextUpdateError;
                      }) => void,
                    ) {
                      recordCall(eqArgs, cols);
                      const error = consumeError();
                      const data = error ? [] : consumeRows();
                      resolve({ data, error });
                    },
                  };
                },
                // H4 CAS chain: `.or(expr).select(cols)` lets the database
                // arbitrate the ordering guard. The mock records the `or`
                // expression text so tests can assert it; behaviorally the
                // returned rows come from `__nextUpdateRows` so a test can
                // simulate "fresher event won" by setting it to `[]`.
                or(orExpr: string) {
                  return {
                    // Awaited directly (no .select) — real PostgREST resolves
                    // an ordering-guarded UPDATE to `{ error }`. Used by the
                    // #13 checkout subscription_id guard.
                    then(
                      resolve: (v: {
                        error: typeof state.__nextUpdateError;
                      }) => void,
                    ) {
                      recordCall(eqArgs, undefined, orExpr);
                      resolve({ error: consumeError() });
                    },
                    select(cols: string) {
                      return {
                        then(
                          resolve: (v: {
                            data: Array<Record<string, unknown>>;
                            error: typeof state.__nextUpdateError;
                          }) => void,
                        ) {
                          recordCall(eqArgs, cols, orExpr);
                          const error = consumeError();
                          const data = error ? [] : consumeRows();
                          resolve({ data, error });
                        },
                      };
                    },
                  };
                },
              };
              return directThenable;
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
  created?: number,
): Stripe.Event {
  return {
    id: `evt_${type}`,
    type,
    // H9: subscription handlers compare event.created against the profile's
    // last applied subscription event timestamp. Default to a recent time so
    // legacy tests don't have to set it.
    created: created ?? Math.floor(Date.UTC(2026, 4, 9) / 1000),
    data: { object },
  } as unknown as Stripe.Event;
}

let client: MockClient;

beforeEach(() => {
  client = makeClient();
  vi.clearAllMocks();
  inngestSendMock.mockReset();
  inngestSendMock.mockResolvedValue({ ids: ['evt_x'] });
});

describe('handleStripeEvent', () => {
  it('checkout.session.completed (payment) calls grant_credit_once and stores customer id (C1)', async () => {
    const event = makeEvent('checkout.session.completed', {
      mode: 'payment',
      client_reference_id: 'user_abc',
      customer: 'cus_111',
    });

    await handleStripeEvent(event, client as unknown as never, {
      previousStatus: null,
      billingEventId: 'evt_row_1',
    });

    // C1: the atomic grant-once RPC is keyed on the billing_events row id,
    // not on `previousStatus`. Idempotency is enforced inside the RPC.
    expect(client.__rpcs).toHaveLength(1);
    expect(client.__rpcs[0]).toEqual({
      name: 'grant_credit_once',
      args: {
        p_event_id: 'evt_row_1',
        p_profile_id: 'user_abc',
        p_delta: 1,
      },
    });

    // The customer id should also be persisted to the profile.
    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.table).toBe('profiles');
    expect(update?.eq).toEqual(['id', 'user_abc']);
    expect(update?.patch['stripe_customer_id']).toBe('cus_111');
  });

  it('checkout.session.completed (payment) on a retry still calls grant_credit_once (C1 — RPC is idempotent)', async () => {
    const event = makeEvent('checkout.session.completed', {
      mode: 'payment',
      client_reference_id: 'user_replay',
      customer: 'cus_replay',
    });

    // C1: under the new model the handler ALWAYS calls grant_credit_once
    // regardless of previousStatus. The RPC's WHERE-clause CAS on
    // billing_events.credit_granted ensures the credit is granted at most
    // once. A replay-cron retry calling with previousStatus='failed' must
    // therefore also call the RPC — previously this attempt was permanently
    // skipped, losing a paying customer's credit if the first try flapped.
    await handleStripeEvent(event, client as unknown as never, {
      previousStatus: 'failed',
      billingEventId: 'evt_row_2',
    });

    expect(client.__rpcs).toHaveLength(1);
    expect(client.__rpcs[0]?.name).toBe('grant_credit_once');
    expect(client.__rpcs[0]?.args).toEqual({
      p_event_id: 'evt_row_2',
      p_profile_id: 'user_replay',
      p_delta: 1,
    });
    // Idempotent customer-id write still happens.
    expect(client.__updates).toHaveLength(1);
    expect(client.__updates[0]?.patch['stripe_customer_id']).toBe('cus_replay');
  });

  it('checkout.session.completed (subscription) records subscription_id + customer link without writing subscription_status (H11)', async () => {
    // H11: the `mode='subscription'` branch must NOT write
    // `subscription_status='active'` — that grants premature paid access for
    // `incomplete` subscriptions (3DS pending). The subscription.created
    // webhook (with H9 ordering guard) is the authoritative source of status.
    const event = makeEvent('checkout.session.completed', {
      mode: 'subscription',
      client_reference_id: 'user_xyz',
      customer: 'cus_222',
      subscription: 'sub_777',
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__rpcs).toHaveLength(0);
    // #13: the subscription_id write is now guarded so a replayed checkout
    // cannot resurrect an id a newer subscription.deleted cleared. This splits
    // into two updates: unconditional stripe_customer_id link + ordering-
    // guarded subscription_id.
    expect(client.__updates).toHaveLength(2);
    const customerUpdate = client.__updates.find(
      (u) => u.patch['stripe_customer_id'] !== undefined,
    );
    const subIdUpdate = client.__updates.find(
      (u) => u.patch['subscription_id'] !== undefined,
    );
    expect(customerUpdate?.table).toBe('profiles');
    expect(customerUpdate?.eq).toEqual(['id', 'user_xyz']);
    expect(customerUpdate?.patch['stripe_customer_id']).toBe('cus_222');
    expect(subIdUpdate?.eq).toEqual(['id', 'user_xyz']);
    expect(subIdUpdate?.patch['subscription_id']).toBe('sub_777');
    // The subscription_id write carries the ordering guard (and does NOT bump
    // subscription_event_at — that stays the subscription.* events' authority).
    expect(subIdUpdate?.or).toContain('subscription_event_at');
    expect(subIdUpdate?.patch).not.toHaveProperty('subscription_event_at');
    // Status must be absent everywhere — not written by checkout at all.
    for (const u of client.__updates) {
      expect(u.patch).not.toHaveProperty('subscription_status');
    }
  });

  it('checkout.session.completed (subscription) writes ONLY id columns — no status fields (H11 column-set assertion)', async () => {
    // Defense-in-depth: enumerate the exact columns written across both writes.
    // Catches any regression that re-introduces status, subscription_event_at,
    // or other state fields that should only be set by the subscription.* handlers.
    const event = makeEvent('checkout.session.completed', {
      mode: 'subscription',
      client_reference_id: 'user_h11',
      customer: 'cus_h11',
      subscription: 'sub_h11',
    });

    await handleStripeEvent(event, client as unknown as never);

    const writtenCols = [
      ...new Set(client.__updates.flatMap((u) => Object.keys(u.patch))),
    ].sort();
    // Union of both updates: subscription_id (link, guarded), stripe_customer_id
    // (link), updated_at (boilerplate). No status, no subscription_event_at,
    // no audit_credits.
    expect(writtenCols).toEqual(
      ['stripe_customer_id', 'subscription_id', 'updated_at'].sort(),
    );
  });

  it('customer.subscription.updated propagates the new status', async () => {
    const event = makeEvent('customer.subscription.updated', {
      id: 'sub_42',
      customer: 'cus_42',
      status: 'past_due',
    });

    await handleStripeEvent(event, client as unknown as never);

    // H9: SELECT current state first, then UPDATE by profile id.
    expect(client.__selects).toHaveLength(1);
    expect(client.__selects[0]?.table).toBe('profiles');
    expect(client.__selects[0]?.eq).toEqual(['stripe_customer_id', 'cus_42']);

    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.table).toBe('profiles');
    expect(update?.eq).toEqual(['id', 'profile_default']);
    expect(update?.patch['subscription_status']).toBe('past_due');
    expect(update?.patch['subscription_id']).toBe('sub_42');
    expect(update?.patch['subscription_event_at']).toEqual(expect.any(String));
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
    expect(update?.patch['subscription_event_at']).toEqual(expect.any(String));
  });

  it('customer.subscription.created with status=trialing persists trialing (C1)', async () => {
    const event = makeEvent('customer.subscription.created', {
      id: 'sub_trial',
      customer: 'cus_trial',
      status: 'trialing',
    });

    await handleStripeEvent(event, client as unknown as never);

    const update = client.__updates[0];
    expect(update?.patch['subscription_status']).toBe('trialing');
  });

  it('access gate returns { ok: true, reason: "subscription" } for trialing profiles (C1)', async () => {
    // Mock the admin client used by assertCanRunAudit.
    vi.resetModules();
    const maybeSingleMock = vi.fn().mockResolvedValue({
      data: { subscription_status: 'trialing', audit_credits: 0 },
      error: null,
    });
    vi.doMock('@/lib/supabase/admin', () => ({
      getAdminClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: () => maybeSingleMock() }),
          }),
        }),
      }),
    }));

    const { assertCanRunAudit } = await import('@/lib/access/gate');
    const result = await assertCanRunAudit('user_trial');
    expect(result).toEqual({ ok: true, reason: 'subscription' });
    vi.doUnmock('@/lib/supabase/admin');
  });

  it('customer.subscription.deleted sets canceled and clears subscription_id', async () => {
    const event = makeEvent('customer.subscription.deleted', {
      id: 'sub_gone',
      customer: 'cus_gone',
      status: 'canceled',
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__selects).toHaveLength(1);
    expect(client.__selects[0]?.eq).toEqual(['stripe_customer_id', 'cus_gone']);

    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.eq).toEqual(['id', 'profile_default']);
    expect(update?.patch['subscription_status']).toBe('canceled');
    expect(update?.patch['subscription_id']).toBeNull();
    expect(update?.patch['subscription_event_at']).toEqual(expect.any(String));
  });

  /**
   * Helper: stage the SELECT queue used by the H2 invoice.payment_failed flow.
   *   1. SELECT id, subscription_event_at (ordering guard read)
   *   2. SELECT id, email                  (post-CAS email lookup)
   *
   * The mock's `__nextSelectRows` slot is consumed on each invocation, so we
   * use a `from(...)` proxy to intercept every subsequent select on the
   * profiles table and pop from a queue. We keep the existing behavior for
   * other tables/calls by re-staging __nextSelectRows from the queue before
   * each invocation.
   */
  function stageInvoiceSelects(
    profileId: string,
    email: string | null,
    subscriptionEventAt: string | null = null,
  ) {
    // Production now does ONE select (the H9 guard) and the email comes back
    // from the UPDATE's .select('id, email') clause — no second SELECT.
    client.__nextSelectRows = [
      {
        id: profileId,
        subscription_event_at: subscriptionEventAt,
        // H1: handler reads subscription_status from the pre-UPDATE row to
        // decide whether to dispatch the email. Stage as null (the typical
        // first-failure shape) so the email path fires.
        subscription_status: null,
      },
    ];
    client.__nextUpdateRows = [{ id: profileId, email }];
  }

  it('invoice.payment_failed marks the profile past_due (H2 routes through CAS guard)', async () => {
    stageInvoiceSelects('profile_x', 'x@example.com');
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_fail',
      customer: 'cus_fail',
    });

    await handleStripeEvent(event, client as unknown as never);

    // H2: the past_due UPDATE is keyed by profile id (not customer id) and
    // includes the CAS `.or()` ordering guard so a stale invoice arriving
    // after a recovery cannot resurrect past_due.
    expect(client.__updates).toHaveLength(1);
    const update = client.__updates[0];
    expect(update?.eq).toEqual(['id', 'profile_x']);
    expect(update?.patch['subscription_status']).toBe('past_due');
    expect(update?.patch['subscription_event_at']).toEqual(expect.any(String));
    expect(update?.or).toMatch(/subscription_event_at\.is\.null/);
    expect(update?.or).toMatch(/subscription_event_at\.lt\./);
    // One SELECT — the H9 guard. The email comes back from the UPDATE's
    // own `.select('id, email')` clause, eliminating the post-CAS re-fetch.
    // H1: also reads `subscription_status` so the email-dispatch gate can
    // suppress duplicate emails on Stripe's dunning retries.
    expect(client.__selects).toHaveLength(1);
    expect(client.__selects[0]?.cols).toBe(
      'id, subscription_event_at, subscription_status',
    );
    expect(update?.select).toBe('id, email');
  });

  it('invoice.payment_failed skips past_due flip when fresher subscription event already landed (H2)', async () => {
    // Profile already has a fresher subscription_event_at than this invoice.
    const fresherTs = new Date(
      Date.UTC(2026, 4, 9, 13, 0, 0),
    ).toISOString();
    client.__nextSelectRows = [
      { id: 'profile_fresh', subscription_event_at: fresherTs },
    ];
    const staleEvent = makeEvent(
      'invoice.payment_failed',
      { id: 'in_stale', customer: 'cus_stale' },
      Math.floor(Date.UTC(2026, 4, 9, 12, 0, 0) / 1000), // 1h older
    );

    await handleStripeEvent(staleEvent, client as unknown as never);

    // No UPDATE, no Inngest dispatch — the stale event is dropped.
    expect(client.__updates).toHaveLength(0);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('invoice.payment_failed dispatches billing.payment_failed Inngest event WITHOUT customerEmail (C2)', async () => {
    stageInvoiceSelects('profile_pay', 'paying@example.com');
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_marker',
      customer: 'cus_marker',
      amount_due: 4900,
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    // C2: the consumer re-fetches the profile by userId; customerEmail is
    // intentionally omitted so PII does not live in Inngest event history.
    expect(inngestSendMock).toHaveBeenCalledWith({
      name: 'billing.payment_failed',
      data: {
        userId: 'profile_pay',
        stripeCustomerId: 'cus_marker',
        invoiceId: 'in_marker',
        amountDueCents: 4900,
      },
    });
    const firstCall = inngestSendMock.mock.calls[0] as unknown as
      | [{ data?: Record<string, unknown> }]
      | undefined;
    const dispatchedData = (firstCall?.[0]?.data ?? {}) as Record<
      string,
      unknown
    >;
    expect(dispatchedData).not.toHaveProperty('customerEmail');
  });

  it('invoice.payment_failed without profile email skips dispatch and warns', async () => {
    stageInvoiceSelects('profile_no_email', null);
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_no_email',
      customer: 'cus_no_email',
      amount_due: 1000,
    });

    await handleStripeEvent(event, client as unknown as never);

    expect(inngestSendMock).not.toHaveBeenCalled();
    // The profile update still ran.
    expect(client.__updates).toHaveLength(1);
    expect(client.__updates[0]?.patch['subscription_status']).toBe('past_due');
  });

  it('invoice.payment_failed suppresses email when profile was already past_due (H1 — dunning retry guard)', async () => {
    // Stripe sends a fresh invoice.payment_failed on every dunning retry
    // (default schedule: 1 retry then 3/5/7 days), each carrying a newer
    // event.created timestamp that passes the CAS. Without the H1 gate,
    // one declined card produced 3-4 separate emails. The pre-UPDATE
    // subscription_status is what decides whether a transition into
    // past_due happened — if it was already past_due, the email is
    // suppressed.
    client.__nextSelectRows = [
      {
        id: 'profile_already_pd',
        subscription_event_at: new Date(
          Date.UTC(2026, 4, 9, 11, 0, 0),
        ).toISOString(),
        subscription_status: 'past_due',
      },
    ];
    client.__nextUpdateRows = [
      { id: 'profile_already_pd', email: 'spam-me-not@example.com' },
    ];

    const retryEvent = makeEvent(
      'invoice.payment_failed',
      {
        id: 'in_dunning_retry',
        customer: 'cus_already_pd',
        amount_due: 1500,
      },
      Math.floor(Date.UTC(2026, 4, 12, 12, 0, 0) / 1000), // 3 days later
    );

    await handleStripeEvent(retryEvent, client as unknown as never);

    // The past_due UPDATE still ran (advances subscription_event_at so
    // the CAS marker stays current).
    expect(client.__updates).toHaveLength(1);
    expect(client.__updates[0]?.patch['subscription_status']).toBe('past_due');
    // But NO Inngest dispatch — user already knows their card is declined.
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('invoice.payment_failed skips past_due flip when profile is incomplete', async () => {
    client.__nextSelectRows = [
      {
        id: 'profile_incomplete',
        subscription_event_at: new Date(
          Date.UTC(2026, 4, 9, 11, 0, 0),
        ).toISOString(),
        subscription_status: 'incomplete',
      },
    ];

    const event = makeEvent(
      'invoice.payment_failed',
      {
        id: 'in_after_incomplete',
        customer: 'cus_incomplete',
        amount_due: 1500,
      },
      Math.floor(Date.UTC(2026, 4, 12, 12, 0, 0) / 1000),
    );

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__updates).toHaveLength(0);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('invoice.payment_failed skips past_due flip when profile is canceled', async () => {
    client.__nextSelectRows = [
      {
        id: 'profile_canceled',
        subscription_event_at: new Date(
          Date.UTC(2026, 4, 9, 11, 0, 0),
        ).toISOString(),
        subscription_status: 'canceled',
      },
    ];

    const event = makeEvent(
      'invoice.payment_failed',
      {
        id: 'in_after_cancel',
        customer: 'cus_canceled',
        amount_due: 1500,
      },
      Math.floor(Date.UTC(2026, 4, 12, 12, 0, 0) / 1000),
    );

    await handleStripeEvent(event, client as unknown as never);

    expect(client.__updates).toHaveLength(0);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('invoice.payment_failed swallows inngest.send errors so past_due update sticks', async () => {
    stageInvoiceSelects('profile_send_err', 'send-err@example.com');
    inngestSendMock.mockRejectedValueOnce(new Error('inngest down'));
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_send_err',
      customer: 'cus_send_err',
      amount_due: 2500,
    });

    await expect(
      handleStripeEvent(event, client as unknown as never),
    ).resolves.toBeUndefined();

    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(client.__updates[0]?.patch['subscription_status']).toBe('past_due');
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

  // --- H9: ordering guard for subscription events --------------------------

  describe('H9 — out-of-order subscription event protection', () => {
    const ACTIVE_TS = Math.floor(Date.UTC(2026, 4, 9, 12, 0, 0) / 1000);
    const STALE_TS = ACTIVE_TS - 3600; // an hour earlier
    const FRESHER_TS = ACTIVE_TS + 3600; // an hour later

    it('refuses subscription.updated whose event.created is older than current subscription_event_at', async () => {
      // Profile already saw a more recent subscription event.
      client.__nextSelectRows = [
        {
          id: 'profile_h9',
          subscription_event_at: new Date(ACTIVE_TS * 1000).toISOString(),
        },
      ];

      const stale = makeEvent(
        'customer.subscription.updated',
        { id: 'sub_h9', customer: 'cus_h9', status: 'active' },
        STALE_TS,
      );

      await handleStripeEvent(stale, client as unknown as never);

      // SELECT happened, but UPDATE must not.
      expect(client.__selects).toHaveLength(1);
      expect(client.__updates).toHaveLength(0);
    });

    it('refuses subscription.updated arriving AFTER subscription.deleted (the H9 regression)', async () => {
      // The deletion happened, profile is now canceled with the deletion's
      // event.created stamp. A delayed `updated` event with status=active
      // arrives later (in delivery order) but with an OLDER event.created.
      client.__nextSelectRows = [
        {
          id: 'profile_h9_canceled',
          subscription_event_at: new Date(ACTIVE_TS * 1000).toISOString(),
        },
      ];

      const stale = makeEvent(
        'customer.subscription.updated',
        { id: 'sub_h9c', customer: 'cus_h9c', status: 'active' },
        STALE_TS,
      );

      await handleStripeEvent(stale, client as unknown as never);

      expect(client.__updates).toHaveLength(0);
    });

    it('applies subscription.updated whose event.created is fresher than current', async () => {
      client.__nextSelectRows = [
        {
          id: 'profile_h9_fresh',
          subscription_event_at: new Date(STALE_TS * 1000).toISOString(),
        },
      ];

      const fresher = makeEvent(
        'customer.subscription.updated',
        { id: 'sub_h9f', customer: 'cus_h9f', status: 'past_due' },
        FRESHER_TS,
      );

      await handleStripeEvent(fresher, client as unknown as never);

      expect(client.__updates).toHaveLength(1);
      const update = client.__updates[0];
      expect(update?.patch['subscription_status']).toBe('past_due');
      expect(update?.patch['subscription_event_at']).toBe(
        new Date(FRESHER_TS * 1000).toISOString(),
      );
    });

    it('applies the first subscription event when subscription_event_at is null', async () => {
      client.__nextSelectRows = [
        { id: 'profile_h9_first', subscription_event_at: null },
      ];

      const event = makeEvent(
        'customer.subscription.created',
        { id: 'sub_h9first', customer: 'cus_h9first', status: 'active' },
        ACTIVE_TS,
      );

      await handleStripeEvent(event, client as unknown as never);

      expect(client.__updates).toHaveLength(1);
      expect(client.__updates[0]?.patch['subscription_event_at']).toBe(
        new Date(ACTIVE_TS * 1000).toISOString(),
      );
    });

    it('refuses subscription.deleted older than current subscription_event_at', async () => {
      client.__nextSelectRows = [
        {
          id: 'profile_h9_del',
          subscription_event_at: new Date(ACTIVE_TS * 1000).toISOString(),
        },
      ];

      const staleDelete = makeEvent(
        'customer.subscription.deleted',
        { id: 'sub_h9d', customer: 'cus_h9d', status: 'canceled' },
        STALE_TS,
      );

      await handleStripeEvent(staleDelete, client as unknown as never);
      expect(client.__updates).toHaveLength(0);
    });
  });

  // --- H4: CAS guard on the UPDATE itself ---------------------------------

  describe('H4 — CAS guard on subscription UPDATE', () => {
    const ACTIVE_TS = Math.floor(Date.UTC(2026, 4, 9, 12, 0, 0) / 1000);

    it('subscription update sends `.or(...)` ordering predicate to the database', async () => {
      client.__nextSelectRows = [
        { id: 'profile_h4', subscription_event_at: null },
      ];

      const event = makeEvent(
        'customer.subscription.updated',
        { id: 'sub_h4', customer: 'cus_h4', status: 'active' },
        ACTIVE_TS,
      );

      await handleStripeEvent(event, client as unknown as never);

      const update = client.__updates[0];
      expect(update?.or).toBeDefined();
      // The CAS expression must accept rows that are still null OR strictly
      // older than this event's timestamp.
      expect(update?.or).toMatch(/subscription_event_at\.is\.null/);
      expect(update?.or).toMatch(/subscription_event_at\.lt\./);
      // It also performs a `.select('id')` so the helper can read the row count.
      expect(update?.select).toBe('id');
    });

    it('CAS UPDATE returning 0 rows is treated as silent skip (fresher event won)', async () => {
      // Pre-check passes (snapshot says null), but the CAS UPDATE returns 0
      // rows because a concurrent fresher writer landed between SELECT and
      // UPDATE. The handler must not throw — it logs a breadcrumb and returns.
      client.__nextSelectRows = [
        { id: 'profile_h4_race', subscription_event_at: null },
      ];
      client.__nextUpdateRows = [];

      const event = makeEvent(
        'customer.subscription.updated',
        { id: 'sub_h4r', customer: 'cus_h4r', status: 'active' },
        ACTIVE_TS,
      );

      await expect(
        handleStripeEvent(event, client as unknown as never),
      ).resolves.toBeUndefined();

      // The UPDATE was attempted (recorded), but no exception thrown.
      expect(client.__updates).toHaveLength(1);
    });
  });

  // --- B7: row-count verification on every customer-id-keyed handler -------

  // For subscription events, row-count verification happens on the SELECT
  // (H9 ordering guard reads profile state first). For invoice.payment_failed
  // it still happens on the UPDATE().select() path. So the two surfaces use
  // different mock knobs.
  describe.each([
    {
      label: 'customer.subscription.updated',
      event: makeEvent('customer.subscription.updated', {
        id: 'sub_b7',
        customer: 'cus_b7',
        status: 'active',
      }),
      countSurface: 'select' as const,
      isTerminal: false,
      expectedThrow: /matched 0 rows .*customer\.subscription\.updated/,
      multiThrow: /matched 2 rows .*customer\.subscription\.updated/,
    },
    {
      label: 'customer.subscription.created',
      event: makeEvent('customer.subscription.created', {
        id: 'sub_b7c',
        customer: 'cus_b7c',
        status: 'active',
      }),
      countSurface: 'select' as const,
      isTerminal: false,
      expectedThrow: /matched 0 rows .*customer\.subscription\.created/,
      multiThrow: /matched 2 rows .*customer\.subscription\.created/,
    },
    {
      label: 'customer.subscription.deleted',
      event: makeEvent('customer.subscription.deleted', {
        id: 'sub_b7d',
        customer: 'cus_b7d',
        status: 'canceled',
      }),
      countSurface: 'select' as const,
      // H11: terminal events (subscription.deleted, invoice.payment_failed)
      // no longer throw on 0-row match; the profile was deleted locally
      // and we no-op instead of generating 13 Sentry warnings per retry.
      isTerminal: true,
      expectedThrow: null,
      multiThrow: /matched 2 rows .*customer\.subscription\.deleted/,
    },
    {
      // H2: invoice.payment_failed now SELECTs the profile (id +
      // subscription_event_at) before the CAS UPDATE, so row-count
      // verification happens on the select surface like the subscription
      // handlers.
      label: 'invoice.payment_failed',
      event: makeEvent('invoice.payment_failed', {
        id: 'in_b7',
        customer: 'cus_b7p',
      }),
      countSurface: 'select' as const,
      isTerminal: true,
      expectedThrow: null,
      multiThrow: /matched 2 rows .*invoice\.payment_failed/,
    },
  ])(
    '$label profile lookup row-count verification (B7)',
    ({ event, countSurface, isTerminal, expectedThrow, multiThrow }) => {
      const setRows = (rows: Array<Record<string, unknown>>) => {
        if (countSurface === 'select') client.__nextSelectRows = rows;
        else client.__nextUpdateRows = rows;
      };

      it('1 row matched: succeeds', async () => {
        setRows([{ id: 'profile_one', email: 'a@b.co' }]);
        await expect(
          handleStripeEvent(event, client as unknown as never),
        ).resolves.toBeUndefined();
      });

      if (isTerminal) {
        it('0 rows matched on a terminal event: no-op (H11)', async () => {
          setRows([]);
          await expect(
            handleStripeEvent(event, client as unknown as never),
          ).resolves.toBeUndefined();
        });
      } else {
        it('0 rows matched: throws so Stripe retries', async () => {
          setRows([]);
          await expect(
            handleStripeEvent(event, client as unknown as never),
          ).rejects.toThrow(expectedThrow as RegExp);
        });
      }

      it('>1 rows matched: throws (data corruption)', async () => {
        setRows([
          { id: 'profile_one', email: 'a@b.co' },
          { id: 'profile_two', email: 'c@d.co' },
        ]);
        await expect(
          handleStripeEvent(event, client as unknown as never),
        ).rejects.toThrow(multiThrow);
      });
    },
  );
});
