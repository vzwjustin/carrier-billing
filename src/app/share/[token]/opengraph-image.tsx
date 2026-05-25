import { ImageResponse } from 'next/og';
import { getAdminClient } from '@/lib/supabase/admin';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'CarrierAudit — Audit findings preview';

// Revalidate every hour so updated audit findings refresh the social card.
export const revalidate = 3600;

interface Params {
  params: Promise<{ token: string }>;
}

interface AuditCard {
  carrier: string | null;
  line_count: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  share_token_expires_at: string | null;
}

const SHARE_TOKEN_LENGTH = 32;
const AUDIT_CARD_COLUMNS =
  'carrier, line_count, finding_count, high_severity_count, estimated_monthly_savings_cents, estimated_annual_savings_cents, billing_period_start, billing_period_end, share_token_expires_at';
const AUDIT_CARD_FALLBACK_COLUMNS =
  'carrier, line_count, finding_count, high_severity_count, estimated_monthly_savings_cents, estimated_annual_savings_cents, billing_period_start, billing_period_end';

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
}

function isMissingColumnError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === '42703' || code === 'PGRST204';
}

/**
 * Dynamic OG image for shared audit reports. Renders the carrier, savings
 * amount, and finding count so when a buyer drops the URL into Slack, email,
 * or LinkedIn the preview card sells the report before the recipient even
 * clicks. Falls back to the static brand card if the audit can't be loaded.
 */
export default async function Image({ params }: Params) {
  const { token } = await params;

  // Load the audit by share token. Service role bypasses RLS — this image is
  // public anyway (the share link grants read access by design).
  let carrier = 'wireless';
  let monthlySavings = 0;
  let annualSavings = 0;
  let findingCount = 0;
  let highCount = 0;
  let lineCount = 0;
  let billingPeriod: string | null = null;

  try {
    let data: AuditCard | null = null;
    if (
      typeof token === 'string' &&
      token.length === SHARE_TOKEN_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(token)
    ) {
      const supabase = getAdminClient();
      const first = await supabase
        .from('audits')
        .select(AUDIT_CARD_COLUMNS)
        .eq('share_token', token)
        .eq('status', 'completed')
        .maybeSingle<AuditCard>();
      if (isMissingColumnError(first.error)) {
        const retry = await supabase
          .from('audits')
          .select(AUDIT_CARD_FALLBACK_COLUMNS)
          .eq('share_token', token)
          .eq('status', 'completed')
          .maybeSingle<Omit<AuditCard, 'share_token_expires_at'>>();
        data = retry.data
          ? { ...retry.data, share_token_expires_at: null }
          : null;
      } else {
        data = first.data;
      }
    }

    if (data && !isExpired(data.share_token_expires_at)) {
      carrier = formatCarrier(data.carrier);
      monthlySavings = data.estimated_monthly_savings_cents ?? 0;
      annualSavings = data.estimated_annual_savings_cents ?? 0;
      findingCount = data.finding_count ?? 0;
      highCount = data.high_severity_count ?? 0;
      lineCount = data.line_count ?? 0;
      const start = data.billing_period_start;
      const end = data.billing_period_end;
      if (start && end) {
        billingPeriod = `${formatMonth(start)} ${new Date(start).getUTCFullYear()}`;
      }
    }
  } catch {
    // fall through to the default card below
  }

  const annualLabel = formatCurrency(annualSavings);
  const monthlyLabel = formatCurrency(monthlySavings);
  const accent = annualSavings > 0 ? '#34d399' : '#fbbf24';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #064e3b 0%, #0f172a 75%, #020617 100%)',
          padding: '76px 88px',
          fontFamily: 'system-ui, sans-serif',
          color: 'white',
          position: 'relative',
        }}
      >
        {/* Top brand */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginBottom: 48,
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: '-0.05em',
              color: 'white',
              boxShadow: '0 8px 24px rgba(16, 185, 129, 0.5)',
            }}
          >
            CA
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }}>CarrierAudit</div>
          <div
            style={{
              marginLeft: 'auto',
              fontSize: 18,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.55)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}
          >
            Audit Report
          </div>
        </div>

        {/* Carrier label */}
        <div
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.7)',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <span>{carrier}</span>
          {billingPeriod && (
            <>
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>•</span>
              <span>{billingPeriod}</span>
            </>
          )}
          {lineCount > 0 && (
            <>
              <span style={{ color: 'rgba(255,255,255,0.3)' }}>•</span>
              <span>
                {lineCount} {lineCount === 1 ? 'line' : 'lines'}
              </span>
            </>
          )}
        </div>

        {/* Big savings number */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginBottom: 'auto',
          }}
        >
          <div
            style={{
              fontSize: 28,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.6)',
              marginBottom: 4,
            }}
          >
            {annualSavings > 0 ? 'Estimated annual savings' : 'Findings ready'}
          </div>
          <div
            style={{
              fontSize: 132,
              fontWeight: 800,
              lineHeight: 1,
              letterSpacing: '-0.05em',
              color: accent,
              display: 'flex',
              alignItems: 'baseline',
              gap: 16,
            }}
          >
            <span>{annualLabel}</span>
            {annualSavings > 0 && (
              <span
                style={{
                  fontSize: 36,
                  color: 'rgba(255,255,255,0.55)',
                  fontWeight: 500,
                }}
              >
                /yr
              </span>
            )}
          </div>
          {monthlySavings > 0 && (
            <div
              style={{
                fontSize: 26,
                fontWeight: 500,
                color: 'rgba(255,255,255,0.65)',
                marginTop: 8,
                display: 'flex',
              }}
            >
              That&apos;s {monthlyLabel} per month — money your business is leaving on the table.
            </div>
          )}
        </div>

        {/* Footer chips */}
        <div
          style={{
            display: 'flex',
            gap: 14,
            fontSize: 22,
            fontWeight: 600,
            marginTop: 48,
          }}
        >
          {findingCount > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '12px 22px',
                background: 'rgba(16, 185, 129, 0.15)',
                border: '2px solid rgba(16, 185, 129, 0.4)',
                borderRadius: 999,
                color: '#a7f3d0',
              }}
            >
              {findingCount} {findingCount === 1 ? 'finding' : 'findings'}
            </div>
          )}
          {highCount > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '12px 22px',
                background: 'rgba(248, 113, 113, 0.15)',
                border: '2px solid rgba(248, 113, 113, 0.4)',
                borderRadius: 999,
                color: '#fecaca',
              }}
            >
              {highCount} high-impact
            </div>
          )}
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              padding: '12px 22px',
              background: 'rgba(255,255,255,0.08)',
              border: '2px solid rgba(255,255,255,0.18)',
              borderRadius: 999,
              color: 'rgba(255,255,255,0.85)',
            }}
          >
            carrieraudit.io
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}

function formatCurrency(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '$0';
  if (cents < 100000) {
    return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
  }
  // Format as $1.2K / $12K / $124K style for big numbers
  const dollars = cents / 100;
  if (dollars < 10000) {
    return `$${(dollars / 1000).toFixed(1)}K`;
  }
  return `$${Math.round(dollars / 1000).toLocaleString('en-US')}K`;
}

function formatCarrier(carrier: string | null): string {
  switch ((carrier ?? '').toLowerCase()) {
    case 'verizon':
      return 'Verizon Business';
    case 'att':
      return 'AT&T Business';
    case 'tmobile':
      return 'T-Mobile for Business';
    default:
      return 'Wireless audit';
  }
}

function formatMonth(iso: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = new Date(iso).getUTCMonth();
  return months[m] ?? '';
}
