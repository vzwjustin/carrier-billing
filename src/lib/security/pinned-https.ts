import { request as httpsRequest } from 'node:https';

export interface PinnedHttpsRequest {
  /** Original destination URL — its hostname drives TLS SNI + cert identity. */
  url: URL;
  /** Pre-vetted IP (from `assertPublicHttpsTarget`) to pin the TCP connect to. */
  resolvedIp: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * POST `body` over HTTPS to `url`, pinning the TCP connection to the
 * pre-vetted `resolvedIp` instead of letting the stack re-resolve the
 * hostname at connect time. This is what defeats DNS rebinding between the
 * SSRF check and the actual request.
 *
 * Correctness note — the bug this helper exists to avoid: you CANNOT pin by
 * putting the IP literal in the URL and `fetch()`-ing it. Node/undici derive
 * the TLS SNI and the certificate identity check from the URL host. An IP
 * literal sends NO SNI (RFC 6066 forbids it) and validates the cert against
 * the IP, so any normal hostname cert fails with
 * `ERR_TLS_CERT_ALTNAME_INVALID` and the request never reaches the receiver.
 * The L7 `Host` header has zero effect on the TLS layer. Instead we keep the
 * real hostname as `servername` (correct SNI + cert identity) and pin only
 * the L3 connect target via a custom `lookup` that hands back the vetted IP.
 *
 * Resolves `{ status }` for ANY response — the caller decides what counts as
 * an error. `node:https` does not follow redirects, so a 3xx surfaces as its
 * status code rather than silently bouncing the request to another host.
 */
export function postPinnedHttps(req: PinnedHttpsRequest): Promise<{ status: number }> {
  const { url, resolvedIp, family, headers, body, timeoutMs } = req;
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers,
        // SNI + certificate identity validate against the real hostname,
        // while `lookup` below sends the bytes to the vetted IP.
        servername: url.hostname,
        timeout: timeoutMs,
        lookup: (_hostname, _options, cb) => {
          cb(null, resolvedIp, family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Drain so the socket can be released; we never read the body (PII).
        res.resume();
        res.on('end', () => resolve({ status }));
      },
    );

    r.on('timeout', () => {
      r.destroy(new Error('webhook timeout'));
    });
    r.on('error', reject);
    r.end(body);
  });
}
