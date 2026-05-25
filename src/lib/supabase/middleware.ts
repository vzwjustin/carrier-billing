import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';

const PROTECTED_PREFIXES = ['/dashboard', '/audits', '/settings', '/billing'];
const AUTH_PAGES = new Set(['/login', '/signup']);

/**
 * Build redirects from the configured public app URL, not request headers.
 * Forwarded Host/Proto can be attacker-controlled at the edge; redirects
 * should only ever point at the deployment's canonical origin.
 */
function buildRedirectUrl(pathname: string, search?: string): URL {
  const url = new URL(env.NEXT_PUBLIC_APP_URL);
  url.pathname = pathname;
  if (search === undefined) {
    // Preserve existing search params (e.g. `?next=`).
  } else if (search === '') {
    url.search = '';
  } else {
    url.search = search;
  }
  return url;
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  // IMPORTANT: refresh the session — this is the whole point of this middleware.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!user && isProtected) {
    const url = buildRedirectUrl('/login');
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (user && AUTH_PAGES.has(pathname)) {
    const url = buildRedirectUrl('/dashboard', '');
    return NextResponse.redirect(url);
  }

  return response;
}
