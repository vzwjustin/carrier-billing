import { NextResponse, type NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/middleware';

/**
 * Build the per-request Content-Security-Policy with a fresh nonce.
 *
 * `'strict-dynamic'` lets nonced loader scripts inject child scripts; in
 * modern browsers it makes the host allowlist informational, but we keep
 * the explicit hosts for older-browser fallback. `'unsafe-inline'` is gone
 * from `script-src`. `style-src 'unsafe-inline'` stays — Next.js 15 inlines
 * style attributes for some primitives, per the documented compromise.
 *
 * Future `<Script>` consumers should read the nonce in a server component:
 *   const nonce = (await headers()).get('x-nonce') ?? undefined;
 *   <Script nonce={nonce} src="..." />
 */
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://*.posthog.com https://*.i.posthog.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://*.posthog.com https://*.i.posthog.com https://*.sentry.io",
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // Forward the nonce to the app via a request header so server components
  // can read it via `headers().get('x-nonce')`.
  request.headers.set('x-nonce', nonce);

  const response = await updateSession(request);

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);

  return response;
}

export const config = {
  matcher: [
    {
      /*
       * Match all request paths except:
       * - _next/static (static files)
       * - _next/image (image optimization)
       * - favicon, robots, sitemap
       * - /api routes (handled separately)
       * - /monitoring (Sentry tunnel — no CSP needed)
       * - common image extensions
       */
      source:
        '/((?!_next/static|_next/image|api/|favicon\\.ico|favicon\\.svg|robots\\.txt|sitemap\\.xml|monitoring|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
