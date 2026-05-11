/**
 * GET /api/health
 *
 * Lightweight liveness check. Public probes must not burn vendor API quota or
 * reveal secret presence. Deep dependency checks belong behind internal auth.
 *
 * Always returns 200 — many uptime monitors prefer a static 200 with the
 * actual status carried in the body.
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type LivenessCheck = { status: 'ok' };

interface HealthBody {
  status: 'ok';
  timestamp: string;
  checks: {
    app: LivenessCheck;
  };
}

export async function GET(): Promise<Response> {
  const body: HealthBody = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    checks: { app: { status: 'ok' } },
  };

  console.log(`[health] status=${body.status}`);

  return NextResponse.json(body, { status: 200 });
}
