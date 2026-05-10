import { NextResponse, type NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/middleware';

/**
 * Build the Content-Security-Policy. This is an allowlist CSP, not a nonce CSP:
 * Next/PostHog/Sentry currently need inline allowances in this app. Keep
 * this comment honest so future hardening can remove those allowances in a
 * deliberate browser-tested pass.
 */
export function buildCsp(): string {
  // unsafe-eval is required by Next dev mode HMR; not needed in production.
  // PostHog and Stripe.js do not require eval. Gate it on NODE_ENV so the
  // production response stays tight.
  const isProd = process.env.NODE_ENV === 'production';
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    ...(isProd ? [] : ["'unsafe-eval'"]),
    'https://js.stripe.com',
    'https://*.posthog.com',
    'https://*.i.posthog.com',
  ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // img-src: explicit hosts only. Bare `https:` would let any HTTPS host
    // load images, which defeats the point of the allowlist. The app loads
    // user-uploaded thumbnails from Supabase storage; data:/blob: cover
    // inline previews and same-origin generated images.
    "img-src 'self' data: blob: https://*.supabase.co",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://*.posthog.com https://*.i.posthog.com https://*.sentry.io",
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const csp = buildCsp();

  const response = await updateSession(request);

  response.headers.set('Content-Security-Policy', csp);

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
