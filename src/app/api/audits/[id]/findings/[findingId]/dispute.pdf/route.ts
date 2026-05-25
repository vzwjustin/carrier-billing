/**
 * GET /api/audits/[id]/findings/[findingId]/dispute.pdf
 *
 * Renders a one-to-two-page PDF "dispute packet" for a single finding. An
 * operator hands this to their carrier rep to request a credit.
 *
 * Access model mirrors `/api/audits/[id]/report.pdf`:
 *   - authenticated owner (server client, RLS-scoped), OR
 *   - public `?token=<share_token>` (admin client, bypasses RLS).
 *
 * Rate limits:
 *   - 20 / 5 min per authed user
 *   - 10 / 5 min per hashed share token
 *
 * No on-disk cache — dispute PDFs are small, hand-edited rarely, and we don't
 * have product evidence yet that the cache would pay off. Re-render on each
 * request keeps the code shape simple; revisit if @react-pdf cost dominates.
 */
import { loadDisputePacket } from '@/disputes/load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function pdfFilename(auditShortId: string, ruleId: string): string {
  return `carrieraudit-dispute-${auditShortId}-${ruleId}.pdf`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; findingId: string }> },
): Promise<Response> {
  const params = await context.params;
  const outcome = await loadDisputePacket(request, params, 'pdf');
  if (outcome.kind === 'response') return outcome.response;
  const packet = outcome.packet;

  // Lazy-import the renderer so @react-pdf/renderer stays out of the cold
  // path until a dispute PDF is actually requested. Mirrors the
  // `/api/audits/[id]/report.pdf` pattern.
  const { renderDisputePdf } = await import('@/disputes/pdf/render');
  const pdfBuffer = await renderDisputePdf(packet);
  const pdfBytes = new Uint8Array(
    pdfBuffer.buffer,
    pdfBuffer.byteOffset,
    pdfBuffer.byteLength,
  );

  const body = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength,
  ) as ArrayBuffer;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${pdfFilename(
        packet.auditShortId,
        packet.ruleId,
      )}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      // Public URL may carry `?token=<share_token>` — keep it out of the
      // Referer header on any outbound navigation. Same posture as
      // report.pdf.
      'Referrer-Policy': 'no-referrer',
    },
  });
}
