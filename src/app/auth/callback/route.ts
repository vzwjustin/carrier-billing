import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';
import { createClient } from '@/lib/supabase/server';

function publicOrigin(): string {
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}

function safeNextPath(input: string | null): string {
  if (!input) return '/dashboard';
  if (input.length === 0 || input.length > 512) return '/dashboard';
  if (!input.startsWith('/')) return '/dashboard';
  if (input.startsWith('//') || input.startsWith('/\\')) return '/dashboard';
  if (input.includes(':') || /[\u0000-\u001f\u007f]/.test(input)) {
    return '/dashboard';
  }
  return input;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = publicOrigin();
  const code = searchParams.get('code');
  const next = safeNextPath(searchParams.get('next'));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
