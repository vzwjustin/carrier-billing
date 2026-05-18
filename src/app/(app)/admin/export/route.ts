import { NextResponse, type NextRequest } from 'next/server';

import { getAdminContext } from '@/lib/admin/guard';
import { getAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [header, ...body].join('\n');
}

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
      .select(
        'id, email, role, audit_credits, subscription_status, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(10000);
    csv = toCsv((data ?? []) as Record<string, unknown>[], [
      'id',
      'email',
      'role',
      'audit_credits',
      'subscription_status',
      'created_at',
    ]);
    filename = 'users.csv';
  } else if (type === 'audits') {
    const { data } = await admin
      .from('audits')
      .select(
        'id, user_id, status, carrier, estimated_annual_savings_cents, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(10000);
    csv = toCsv((data ?? []) as Record<string, unknown>[], [
      'id',
      'user_id',
      'status',
      'carrier',
      'estimated_annual_savings_cents',
      'created_at',
    ]);
    filename = 'audits.csv';
  } else {
    return NextResponse.json(
      { error: 'Unknown export type' },
      { status: 400 },
    );
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
