export const runtime = 'nodejs';
import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';
import { createClient } from '@/lib/supabase/server';

function publicOrigin(): string {
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}

export async function POST(_request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(`${publicOrigin()}/`, { status: 303 });
}
