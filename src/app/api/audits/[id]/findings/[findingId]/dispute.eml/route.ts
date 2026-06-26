/**
 * GET /api/audits/[id]/findings/[findingId]/dispute.eml
 *
 * Returns a minimal RFC 822 message file the operator can save and open in
 * their email client. Body is plain-text only — no MIME parts, no PDF
 * attachment — matching the brief: "pure text, paste-into-email".
 *
 * Auth + rate-limit model is identical to the sibling dispute.pdf route;
 * both consume `loadDisputePacket()` for a single source of truth on
 * lookup + authorization.
 */
import { buildDisputeEml } from '@/disputes/email';
import { loadDisputePacket } from '@/disputes/load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function emlFilename(auditShortId: string, ruleId: string): string {
  return `carrieraudit-dispute-${auditShortId}-${ruleId}.eml`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; findingId: string }> },
): Promise<Response> {
  const params = await context.params;
  const outcome = await loadDisputePacket(request, params, 'eml');
  if (outcome.kind === 'response') return outcome.response;
  const packet = outcome.packet;

  const body = buildDisputeEml(packet);

  return new Response(body, {
    status: 200,
    headers: {
      // RFC 822 message format. Most desktop mail clients open this as a
      // pre-populated draft when the file is double-clicked.
      'Content-Type': 'message/rfc822; charset=utf-8',
      'Content-Disposition': `attachment; filename="${emlFilename(
        packet.auditShortId,
        packet.ruleId,
      )}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
