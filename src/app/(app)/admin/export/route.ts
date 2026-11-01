export const runtime = 'nodejs';
import { NextResponse, type NextRequest } from 'next/server';

import { getAdminContext } from '@/lib/admin/guard';
// #12: use the shared, formula-injection-guarded CSV writer instead of a
// private copy. The local csvCell only double-quoted values and did NOT
// neutralize spreadsheet formula prefixes (= + - @), so a stored
// profiles.email beginning with one would execute when an admin opened the
// export. lib/csv.csvCell prefixes those with an apostrophe.
import { toCsv } from '@/lib/csv';
import { getAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await getAdminContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const type = req.nextUrl.searchParams.get('type');
  const admin = getAdminClient();

  let csv: string;
  let filename: string;

  if (type === 'users') {
    const { data } = await admin
      .from('profiles')
      .select('id, email, role, audit_credits, subscription_status, created_at')
      .order('created_at', { ascending: false })
      .limit(10000);
    {
      const cols = ['id', 'email', 'role', 'audit_credits', 'subscription_status', 'created_at'];
      csv = toCsv(
        cols,
        ((data ?? []) as Record<string, unknown>[]).map((r) => cols.map((c) => r[c])),
      );
    }
    filename = 'users.csv';
  } else if (type === 'audits') {
    const { data } = await admin
      .from('audits')
      .select('id, user_id, status, carrier, estimated_annual_savings_cents, created_at')
      .order('created_at', { ascending: false })
      .limit(10000);
    {
      const cols = [
        'id',
        'user_id',
        'status',
        'carrier',
        'estimated_annual_savings_cents',
        'created_at',
      ];
      csv = toCsv(
        cols,
        ((data ?? []) as Record<string, unknown>[]).map((r) => cols.map((c) => r[c])),
      );
    }
    filename = 'audits.csv';
  } else {
    return NextResponse.json({ error: 'Unknown export type' }, { status: 400 });
  }

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
