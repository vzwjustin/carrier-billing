import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test so vi.mock factories
// run with the mock fns in scope.
// ---------------------------------------------------------------------------

const insertMock = vi.fn<(row: unknown) => Promise<{ error: null | { message: string } }>>();
const fromMock = vi.fn((_table: string) => ({
  insert: (row: unknown) => insertMock(row),
}));
const getAdminClientMock = vi.fn(() => ({ from: fromMock }));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => getAdminClientMock(),
}));

const captureExceptionMock = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

// Import after mocks are registered.
import { logTrailEvent, maskEmail } from '@/lib/audit-trail/log';

beforeEach(() => {
  insertMock.mockReset();
  fromMock.mockClear();
  getAdminClientMock.mockClear();
  captureExceptionMock.mockReset();
  insertMock.mockResolvedValue({ error: null });
  // Opt into the real logger body — route tests rely on the no-op default.
  process.env.RUN_AUDIT_TRAIL = '1';
});

afterEach(() => {
  delete process.env.RUN_AUDIT_TRAIL;
});

describe('maskEmail', () => {
  it('keeps the first character of the local part and the full domain', () => {
    expect(maskEmail('justin@example.com')).toBe('j***@example.com');
  });

  it('collapses multi-char local parts the same way', () => {
    expect(maskEmail('jq@example.com')).toBe('j***@example.com');
  });

  it('handles a single-character local part', () => {
    expect(maskEmail('j@example.com')).toBe('j***@example.com');
  });

  it('trims whitespace before masking', () => {
    expect(maskEmail('  justin@example.com  ')).toBe('j***@example.com');
  });

  it('returns null for empty / null / undefined input', () => {
    expect(maskEmail('')).toBeNull();
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
  });

  it('returns null when there is no `@`', () => {
    expect(maskEmail('not-an-email')).toBeNull();
  });

  it('returns null when the `@` is at the boundary', () => {
    expect(maskEmail('@example.com')).toBeNull();
    expect(maskEmail('justin@')).toBeNull();
  });
});

describe('logTrailEvent', () => {
  it('inserts a row through the admin client with the masked email', async () => {
    await logTrailEvent({
      userId: 'user-1',
      eventType: 'finding_status_changed',
      entityType: 'finding',
      entityId: '00000000-0000-0000-0000-000000000001',
      metadata: { audit_id: 'audit-1', status: 'approved' },
      actorEmail: 'justin@example.com',
    });

    expect(getAdminClientMock).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith('audit_trail_events');
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row['user_id']).toBe('user-1');
    expect(row['event_type']).toBe('finding_status_changed');
    expect(row['entity_type']).toBe('finding');
    expect(row['entity_id']).toBe('00000000-0000-0000-0000-000000000001');
    expect(row['actor_email']).toBe('j***@example.com');
    expect(row['metadata']).toEqual({
      audit_id: 'audit-1',
      status: 'approved',
    });
  });

  it('defaults metadata to {} when omitted', async () => {
    await logTrailEvent({
      userId: 'user-2',
      eventType: 'audit_completed',
    });

    const row = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row['metadata']).toEqual({});
    expect(row['entity_type']).toBeNull();
    expect(row['entity_id']).toBeNull();
    expect(row['actor_email']).toBeNull();
  });

  it('drops oversized metadata wholesale and replaces with a sentinel', async () => {
    // Build a payload that's > 1024 bytes after JSON.stringify.
    const big: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) {
      big[`key_${i}`] = 'xxxxxxxxxx'; // 10 chars each → easily > 1KB after keys.
    }
    await logTrailEvent({
      userId: 'user-3',
      eventType: 'audit_uploaded',
      metadata: big,
    });

    const row = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row['metadata']).toEqual({ truncated: true });
  });

  it('NEVER throws even when the insert errors', async () => {
    insertMock.mockResolvedValueOnce({
      error: { message: 'check constraint violated' },
    });

    await expect(
      logTrailEvent({
        userId: 'user-4',
        eventType: 'finding_status_changed',
      }),
    ).resolves.toBeUndefined();

    // Sentry was notified.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('NEVER throws even when the admin client throws synchronously', async () => {
    getAdminClientMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(
      logTrailEvent({
        userId: 'user-5',
        eventType: 'audit_completed',
      }),
    ).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('uses the admin client (service-role) rather than the user-scoped client', async () => {
    await logTrailEvent({
      userId: 'user-6',
      eventType: 'audit_uploaded',
    });

    // Mock guarantees this — the assertion documents the contract for
    // anyone reading the test: writes go through getAdminClient(), never
    // through createClient(). The table's RLS has no INSERT policy, so an
    // RLS-scoped client would silently no-op (or 403) on every call.
    expect(getAdminClientMock).toHaveBeenCalledTimes(1);
  });
});
