import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ReportView } from '@/components/audits/report-view';
import { trackServer } from '@/lib/analytics/events';
import { hashTokenForAnalytics } from '@/lib/analytics/hash';
import { isShareTokenExpired } from '@/lib/share-token';
import { getAdminClient } from '@/lib/supabase/admin';
import { buildReportData } from '@/reports/builder';
import type {
  ReportAccountRow,
  ReportAuditRow,
  ReportCreditRow,
  ReportData,
  ReportDppInstallmentRow,
  ReportFeatureRow,
  ReportFindingRow,
  ReportLineRow,
} from '@/reports/types';

export const dynamic = 'force-dynamic';

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
};

interface MetadataAuditRow {
  carrier: string | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  line_count: number | null;
  share_token_expires_at: string | null;
}

function formatUsdShort(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || cents === 0) return '$0';
  const dollars = Math.round(cents / 100);
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 10_000) return `$${(dollars / 1_000).toFixed(1)}k`;
  return `$${dollars.toLocaleString('en-US')}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const fallback: Metadata = {
    title: 'Shared audit — CarrierAudit',
    description:
      'A real, third-party wireless bill audit shared via CarrierAudit. See where this business is overpaying.',
    robots: { index: false, follow: false },
  };

  if (
    typeof token !== 'string' ||
    token.length !== SHARE_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    return fallback;
  }

  try {
    const supabase = getAdminClient();
    const metadataColumns =
      'carrier, estimated_annual_savings_cents, finding_count, line_count, share_token_expires_at';
    const metadataFallbackColumns =
      'carrier, estimated_annual_savings_cents, finding_count, line_count';
    const first = await supabase
      .from('audits')
      .select(metadataColumns)
      .eq('share_token', token)
      .eq('status', 'completed')
      .maybeSingle<MetadataAuditRow>();
    let data = first.data;
    let error = first.error;
    let expiryColumnAvailable = true;

    if (error && isMissingColumnError(error)) {
      const retry = await supabase
        .from('audits')
        .select(metadataFallbackColumns)
        .eq('share_token', token)
        .eq('status', 'completed')
        .maybeSingle<Omit<MetadataAuditRow, 'share_token_expires_at'>>();
      data = retry.data ? { ...retry.data, share_token_expires_at: null } : null;
      error = retry.error;
      expiryColumnAvailable = false;
    }

    if (error) return fallback;
    if (!data) return fallback;
    if (isShareTokenExpired(data.share_token_expires_at, expiryColumnAvailable)) {
      return fallback;
    }

    const carrierLabel = data.carrier ? (CARRIER_LABELS[data.carrier] ?? 'wireless') : 'wireless';
    const annual = formatUsdShort(data.estimated_annual_savings_cents);
    const findingPart =
      data.finding_count && data.finding_count > 0
        ? `${data.finding_count} finding${data.finding_count === 1 ? '' : 's'}`
        : 'no findings';
    const linePart =
      data.line_count && data.line_count > 0
        ? `${data.line_count} line${data.line_count === 1 ? '' : 's'}`
        : 'this account';

    const title = `${carrierLabel} bill audit — ${annual}/yr in potential savings`;
    const description = `CarrierAudit found ${findingPart} across ${linePart} on this ${carrierLabel} bill. Run your own audit at carrieraudit.io.`;

    return {
      title,
      description,
      robots: { index: false, follow: false },
      openGraph: {
        title,
        description,
        type: 'article',
        url: `/share/${token}`,
        siteName: 'CarrierAudit',
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
      },
    };
  } catch {
    return fallback;
  }
}

const SEVERITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

interface AuditRow {
  id: string;
  status: string;
  carrier: string | null;
  line_count: number | null;
  account_count: number | null;
  total_charges_cents: number | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  completed_at: string | null;
  extraction_confidence: string | null;
  share_token_expires_at: string | null;
}

// Tokens are `randomBytes(24).toString('base64url')`, which is exactly 32 chars.
// Anything else is a probe and we 404 before touching the DB.
const SHARE_TOKEN_LENGTH = 32;

function isMissingColumnError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === '42703' || code === 'PGRST204';
}

export default async function ShareReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.JSX.Element> {
  const { token } = await params;

  // M3: token sanity. The generator emits exactly 32 chars of
  // base64url (randomBytes(24)). Reject anything that isn't the right
  // length AND character set before issuing a DB query — keeps input
  // hygiene consistent with /api/audits/[id]/report.pdf, which enforces
  // the same regex.
  if (
    typeof token !== 'string' ||
    token.length !== SHARE_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    notFound();
  }

  // Public route — use the admin client so we don't require an auth cookie.
  // We still gate access by the share_token + completed status.
  const supabase = getAdminClient();
  // Try to fetch with the share-token expiry column. If the deployed schema
  // is missing it (older deployment), retry without — the expiry check
  // becomes a no-op (audit.share_token_expires_at stays null).
  const fullColumns =
    'id,status,carrier,line_count,account_count,total_charges_cents,billing_period_start,billing_period_end,estimated_monthly_savings_cents,estimated_annual_savings_cents,finding_count,high_severity_count,completed_at,extraction_confidence,share_token_expires_at';
  const fallbackColumns =
    'id,status,carrier,line_count,account_count,total_charges_cents,billing_period_start,billing_period_end,estimated_monthly_savings_cents,estimated_annual_savings_cents,finding_count,high_severity_count,completed_at,extraction_confidence';

  let audit: AuditRow | null = null;
  let error: { code?: string; message?: string } | null = null;
  let expiryColumnAvailable = true;
  {
    const first = await supabase
      .from('audits')
      .select(fullColumns)
      .eq('share_token', token)
      .maybeSingle<AuditRow>();
    if (isMissingColumnError(first.error)) {
      // share_token_expires_at column missing — retry without it.
      const retry = await supabase
        .from('audits')
        .select(fallbackColumns)
        .eq('share_token', token)
        .maybeSingle<Omit<AuditRow, 'share_token_expires_at'>>();
      if (retry.data) {
        audit = { ...retry.data, share_token_expires_at: null };
      }
      error = retry.error as { code?: string; message?: string } | null;
      expiryColumnAvailable = false;
    } else {
      audit = first.data;
      error = first.error as { code?: string; message?: string } | null;
    }
  }

  if (error || !audit) {
    notFound();
  }

  if (audit.status !== 'completed') {
    notFound();
  }

  if (isShareTokenExpired(audit.share_token_expires_at, expiryColumnAvailable)) {
    notFound();
  }

  const auditId = audit.id;
  const [findingsRes, accountsRes, linesRes, featuresRes, creditsRes, dppRes] = await Promise.all([
    supabase
      .from('findings')
      .select(
        'id,rule_id,severity,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids,evidence,status',
      )
      .eq('audit_id', auditId),
    supabase
      .from('bill_accounts')
      .select('id,audit_id,account_label,account_number_masked,total_charges_cents')
      .eq('audit_id', auditId),
    supabase.from('bill_lines').select('id,audit_id,account_id').eq('audit_id', auditId),
    supabase.from('bill_features').select('id,line_id,audit_id').eq('audit_id', auditId),
    supabase.from('bill_credits').select('id,line_id,account_id,audit_id').eq('audit_id', auditId),
    supabase.from('bill_dpp_installments').select('id,line_id,audit_id').eq('audit_id', auditId),
  ]);

  const queryError =
    findingsRes.error ??
    accountsRes.error ??
    linesRes.error ??
    featuresRes.error ??
    creditsRes.error ??
    dppRes.error;
  if (queryError) {
    throw new Error('Failed to load shared audit report data.');
  }

  const findings = (findingsRes.data ?? []) as ReportFindingRow[];
  findings.sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 99;
    const rb = SEVERITY_RANK[b.severity] ?? 99;
    if (ra !== rb) return ra - rb;
    return b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents;
  });

  const auditRow: ReportAuditRow = {
    id: audit.id,
    carrier: audit.carrier,
    billing_period_start: audit.billing_period_start,
    billing_period_end: audit.billing_period_end,
    total_charges_cents: audit.total_charges_cents,
    account_count: audit.account_count,
    line_count: audit.line_count,
    finding_count: audit.finding_count,
    high_severity_count: audit.high_severity_count,
    estimated_monthly_savings_cents: audit.estimated_monthly_savings_cents,
    estimated_annual_savings_cents: audit.estimated_annual_savings_cents,
    completed_at: audit.completed_at,
    extraction_confidence: audit.extraction_confidence,
  };

  const report: ReportData = buildReportData({
    audit: auditRow,
    findings,
    accounts: (accountsRes.data ?? []) as ReportAccountRow[],
    lines: (linesRes.data ?? []) as ReportLineRow[],
    features: (featuresRes.data ?? []) as ReportFeatureRow[],
    credits: (creditsRes.data ?? []) as ReportCreditRow[],
    dppInstallments: (dppRes.data ?? []) as ReportDppInstallmentRow[],
  });

  // Phase 5 analytics: fire `report_viewed` for the public share. The share
  // token serves as the anonymous distinctId — viewers aren't logged in.
  try {
    await trackServer(
      {
        name: 'report_viewed',
        properties: { auditId, isPublic: true },
      },
      hashTokenForAnalytics(token),
    );
  } catch {
    // ignore
  }

  const carrierLabel = audit.carrier ? (CARRIER_LABELS[audit.carrier] ?? 'wireless') : 'wireless';
  const annualSavings = formatUsdShort(audit.estimated_annual_savings_cents);

  // JSON-LD Report/Article schema so search engines (and richer link
  // previews) understand this is a structured business report rather than
  // a generic page. Helps when CarrierAudit reports get linked in
  // newsletters/Slack/LinkedIn.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Report',
    name: `${carrierLabel} wireless bill audit`,
    headline: `${carrierLabel} bill audit — ${annualSavings}/yr in potential savings`,
    description: `Independent audit of a ${carrierLabel} business wireless bill. Found ${audit.finding_count ?? 0} optimization opportunit${(audit.finding_count ?? 0) === 1 ? 'y' : 'ies'} across ${audit.line_count ?? 0} line${(audit.line_count ?? 0) === 1 ? '' : 's'}.`,
    datePublished: audit.completed_at,
    author: {
      '@type': 'Organization',
      name: 'CarrierAudit',
      url: 'https://carrieraudit.io',
    },
    publisher: {
      '@type': 'Organization',
      name: 'CarrierAudit',
      logo: {
        '@type': 'ImageObject',
        url: 'https://carrieraudit.io/icon',
      },
    },
    about: {
      '@type': 'Thing',
      name: `${carrierLabel} business wireless billing optimization`,
    },
  };

  return (
    <div className="space-y-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Wireless bill audit
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            Independent report from CarrierAudit · {carrierLabel} bill
          </p>
        </div>
        <Link
          href="/?utm_source=share&utm_medium=link&utm_campaign=share_cta"
          className="inline-flex items-center justify-center self-start rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none sm:self-auto"
        >
          Audit your own bill
        </Link>
      </div>
      <ReportView report={report} isPublic shareToken={token} />
    </div>
  );
}
