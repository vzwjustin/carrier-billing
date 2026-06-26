import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for postPinnedHttps — the IP-pinned HTTPS transport behind both
 * webhook dispatchers.
 *
 * The whole point of this helper is that it connects to a pre-vetted IP
 * (DNS-rebinding defense) WITHOUT breaking TLS: the cert must still validate
 * against the original hostname. We mock `node:https` so we can assert the
 * exact connect options — specifically that `servername` is the hostname (not
 * the IP) and that the custom `lookup` hands back the vetted IP. Those two
 * facts together are what a fetch-to-IP-literal approach gets wrong.
 */

const httpsRequestMock = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({
  request: httpsRequestMock,
  default: { request: httpsRequestMock },
}));

import { postPinnedHttps } from '@/lib/security/pinned-https';

interface CapturedReq {
  endBody: string | null;
  handlers: Record<string, (arg?: unknown) => void>;
  destroy: ReturnType<typeof vi.fn>;
}

let capturedOptions: Record<string, unknown> | null = null;
let capturedReq: CapturedReq | null = null;

/** Make `request()` simulate a receiver that responds with `status`. */
function mockResponse(status: number): void {
  httpsRequestMock.mockImplementation(
    (options: Record<string, unknown>, cb: (res: unknown) => void) => {
      capturedOptions = options;
      const endHandlers: Array<() => void> = [];
      const res = {
        statusCode: status,
        resume: vi.fn(),
        on: (event: string, handler: () => void) => {
          if (event === 'end') endHandlers.push(handler);
        },
      };
      cb(res);
      // Fire `end` after the synchronous request() wiring completes so the
      // returned promise settles.
      queueMicrotask(() => endHandlers.forEach((h) => h()));
      const req: CapturedReq = {
        endBody: null,
        handlers: {},
        destroy: vi.fn(),
      };
      capturedReq = req;
      return {
        on: (event: string, h: (arg?: unknown) => void) => {
          req.handlers[event] = h;
        },
        end: (body: string) => {
          req.endBody = body;
        },
        destroy: req.destroy,
      };
    },
  );
}

const BASE = {
  resolvedIp: '203.0.113.10',
  family: 4 as const,
  headers: { 'Content-Type': 'application/json', Host: 'hook.example.com' },
  body: '{"hello":"world"}',
  timeoutMs: 15_000,
};

beforeEach(() => {
  capturedOptions = null;
  capturedReq = null;
  httpsRequestMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('postPinnedHttps — TLS pinning wiring', () => {
  it('sets servername to the hostname (NOT the IP) so the cert validates', async () => {
    mockResponse(200);
    await postPinnedHttps({
      ...BASE,
      url: new URL('https://hook.example.com/cb?x=1'),
    });

    expect(capturedOptions).not.toBeNull();
    // The connect uses the hostname for SNI + certificate identity.
    expect(capturedOptions!.hostname).toBe('hook.example.com');
    expect(capturedOptions!.servername).toBe('hook.example.com');
    // The IP literal must NOT be used as the TLS host (that's the bug).
    expect(capturedOptions!.servername).not.toBe('203.0.113.10');
    expect(capturedOptions!.method).toBe('POST');
    expect(capturedOptions!.path).toBe('/cb?x=1');
    expect(capturedOptions!.port).toBe(443);
  });

  it('pins the actual connect to the vetted IP via a custom lookup', async () => {
    mockResponse(200);
    await postPinnedHttps({
      ...BASE,
      url: new URL('https://hook.example.com/cb'),
    });

    const lookup = capturedOptions!.lookup as (
      hostname: string,
      options: unknown,
      cb: (err: Error | null, addr: string, family: number) => void,
    ) => void;
    expect(typeof lookup).toBe('function');

    const cb = vi.fn();
    lookup('hook.example.com', {}, cb);
    // The resolver hands back the pre-vetted IP + family — no real DNS.
    expect(cb).toHaveBeenCalledWith(null, '203.0.113.10', 4);
  });

  it('uses the explicit port when present and forwards body + headers', async () => {
    mockResponse(200);
    await postPinnedHttps({
      ...BASE,
      url: new URL('https://hook.example.com:8443/cb'),
    });

    expect(capturedOptions!.port).toBe(8443);
    expect((capturedOptions!.headers as Record<string, string>).Host).toBe('hook.example.com');
    expect(capturedReq!.endBody).toBe('{"hello":"world"}');
  });
});

describe('postPinnedHttps — status handling', () => {
  it('resolves { status } for a 2xx', async () => {
    mockResponse(200);
    const result = await postPinnedHttps({
      ...BASE,
      url: new URL('https://hook.example.com/cb'),
    });
    expect(result).toEqual({ status: 200 });
  });

  it('resolves (does NOT throw) on a 3xx — no redirect following, caller decides', async () => {
    mockResponse(302);
    const result = await postPinnedHttps({
      ...BASE,
      url: new URL('https://hook.example.com/cb'),
    });
    expect(result).toEqual({ status: 302 });
  });

  it('resolves with the status for a 5xx', async () => {
    mockResponse(503);
    const result = await postPinnedHttps({
      ...BASE,
      url: new URL('https://hook.example.com/cb'),
    });
    expect(result).toEqual({ status: 503 });
  });
});

describe('postPinnedHttps — error + timeout', () => {
  it('rejects when the socket errors', async () => {
    httpsRequestMock.mockImplementation(() => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      return {
        on: (event: string, h: (arg?: unknown) => void) => {
          handlers[event] = h;
        },
        end: () => {
          queueMicrotask(() => handlers.error?.(new Error('socket fail')));
        },
        destroy: vi.fn(),
      };
    });

    await expect(
      postPinnedHttps({ ...BASE, url: new URL('https://hook.example.com/cb') }),
    ).rejects.toThrow('socket fail');
  });

  it('destroys the request with a timeout error on the timeout event', async () => {
    const destroy = vi.fn();
    httpsRequestMock.mockImplementation(() => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      return {
        on: (event: string, h: (arg?: unknown) => void) => {
          handlers[event] = h;
        },
        end: () => {
          queueMicrotask(() => handlers.timeout?.());
        },
        // Real node:https destroy(err) emits an 'error' event carrying err;
        // mirror that so the promise rejects.
        destroy: (err?: unknown) => {
          destroy(err);
          handlers.error?.(err);
        },
      };
    });

    await expect(
      postPinnedHttps({ ...BASE, url: new URL('https://hook.example.com/cb') }),
    ).rejects.toThrow('webhook timeout');
    expect(destroy).toHaveBeenCalled();
  });
});
