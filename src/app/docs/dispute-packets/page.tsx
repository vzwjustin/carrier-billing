import type { Metadata } from 'next';
import Link from 'next/link';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Dispute packets — CarrierAudit docs',
  description:
    'Turn findings into carrier-ready dispute packets. Single-finding PDFs, bulk dispute letters, and the email draft you copy into your carrier rep’s inbox.',
};

export default function DocsDisputePacketsPage(): React.ReactElement {
  return (
    <div className="flex flex-col gap-10 text-neutral-700">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          Dispute packets
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
          Turn findings into carrier-ready paperwork
        </h1>
        <p className="max-w-2xl text-sm sm:text-base">
          A finding without a follow-up is just an observation. CarrierAudit generates two flavors
          of dispute packet so you can hand a clean paper trail to your carrier representative.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">Single-finding packets</h2>
        <p>
          On any finding card, the <strong>Dispute</strong> action generates a per-finding packet
          describing one specific issue &mdash; for example, an expired promotional credit on a
          named account or a completed device payment that hasn&apos;t come off a particular line.
          Single-finding packets are the right choice when:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>The finding is high-severity and you want it tracked as its own carrier case.</li>
          <li>
            The recommended action requires the carrier to look at one specific row on one specific
            line.
          </li>
          <li>You want a clean email thread per dispute so the back-and-forth stays scoped.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">Bulk dispute letters</h2>
        <p>
          When several findings on the same audit share a theme &mdash; for example, six expired
          credits across four accounts, or a dozen suspended-but-billed lines &mdash; a single bulk
          letter is easier for the carrier rep to action than six separate emails. The{' '}
          <strong>Dispute letter</strong> action on the audit page rolls every selected finding into
          one PDF, with a table of affected lines, the recommended action per finding, and a summary
          of the total amount being disputed.
        </p>
        <p>Bulk letters work best when:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            You have an established rep relationship and they prefer a single quarterly clean-up
            packet.
          </li>
          <li>
            The findings are all the same shape (e.g. all expired credits) and the rep can process
            them as a batch.
          </li>
          <li>
            You&apos;re building a paper trail for finance / procurement and want one signed letter
            in the file.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">PDF and EML outputs</h2>
        <p>Both single-finding and bulk packets ship in two formats:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>PDF</strong> &mdash; a printable letter with your audit ID, the affected account
            and line list (masked to last-4 only), the finding description, the recommended action,
            and an estimated monthly savings figure. Attach it to an email or send it through your
            TEM portal.
          </li>
          <li>
            <strong>EML</strong> &mdash; a plain-text RFC 822 email draft with the subject
            pre-filled and the body laid out the way a carrier rep expects to read it. Open it in
            any desktop mail client; review, edit recipients, and send.
          </li>
        </ul>
        <p>
          PII discipline applies throughout. Account numbers and MDNs are masked to their last four
          digits, employee names never appear, and the bill text itself is never quoted verbatim.
          The only identifying number on a packet is the CarrierAudit audit id, so the rep has a way
          to ask follow-up questions without you forwarding the underlying bill.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">
          How carrier reps typically respond
        </h2>
        <p>A few patterns we&apos;ve seen across hundreds of disputes:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Expired promo credits</strong> are usually the highest-yield disputes. Reps
            either renew the credit, apply a replacement, or backdate &mdash; sometimes all three.
            Most resolve in one or two emails.
          </li>
          <li>
            <strong>Completed device payments still billing</strong> resolve quickly once the rep
            pulls the equipment installment ledger. Expect a one-time credit for the over-billed
            months plus the line item dropping off the next cycle.
          </li>
          <li>
            <strong>Suspended-but-billed lines</strong> need the carrier to verify the suspension
            date in their system. Once confirmed, retroactive credits are common.
          </li>
          <li>
            <strong>Contract rate mismatches</strong> take longer and require the rep to loop in an
            account manager. Bring the signed contract terms to the conversation.
          </li>
          <li>
            <strong>Stale international features</strong> typically resolve in one round &mdash; the
            rep removes the feature going forward; a credit for prior months depends on the rep.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">Authoring tips</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Lead with the ask.</strong> The first line of the email body should be the
            action you want the rep to take, not the explanation. The generated email drafts already
            follow this shape.
          </li>
          <li>
            <strong>Keep the affected-lines table.</strong> Carrier reps verify against an internal
            list of last-4s &mdash; if you strip the table, expect a round-trip asking for it.
          </li>
          <li>
            <strong>Cite the audit id.</strong> The packet header carries a stable id; quoting it
            speeds up follow-up tickets.
          </li>
          <li>
            <strong>Don&apos;t edit the savings number down.</strong> The number reflects the
            finding&apos;s monthly impact; rounding it down to be polite hurts your leverage on
            retroactive credits.
          </li>
          <li>
            <strong>Send one packet at a time on a fresh thread.</strong> Reps optimize for closing
            tickets; one packet per thread keeps their queue clean and yours easy to follow up on.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">Related</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <Link
              href="/docs/rules"
              className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              Rules engine
            </Link>{' '}
            &mdash; which findings are dispute-worthy.
          </li>
          <li>
            <Link
              href="/docs/bill-increase-autopsy"
              className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              Bill Increase Autopsy
            </Link>{' '}
            &mdash; the &ldquo;disputable&rdquo; drivers map straight to dispute packets.
          </li>
        </ul>
      </section>
    </div>
  );
}
