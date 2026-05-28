/**
 * /preview/assistant — fixture view of the assistant chat for screenshots.
 *
 * The real /assistant page renders the AssistantChat client component
 * which talks to /api/assistant. For preview purposes we render a
 * static replica of the chat's "after answer" state so the citation
 * chips and message bubbles are visible without a real LLM round-trip.
 */
export const dynamic = 'force-static';

export default function PreviewAssistantPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">
          AI assistant
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Ask anything about your audits, findings, autopsy, or contracts.
          Every answer cites the data it used; nothing is invented.
        </p>
      </div>
      <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
        {/* User message */}
        <div className="flex justify-end">
          <div className="max-w-2xl rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm text-white">
            Why did my April bill increase compared with March?
          </div>
        </div>
        {/* Assistant message */}
        <div className="flex justify-start">
          <div className="max-w-3xl rounded-2xl rounded-bl-sm bg-neutral-50 px-4 py-3 text-sm text-neutral-900">
            <p className="whitespace-pre-line leading-relaxed">
              {`Your April bill went up by $843.21 compared with March. The biggest drivers were:

  • +$312.00 from 8 new device installments on smartphones (iPhone 16 Pro and Samsung Galaxy S25 lines)
  • +$220.00 from 11 lines that lost a recurring promo credit ("BYOD Loyalty Bonus") with no matching device payoff or plan change — this one looks disputable
  • +$146.00 from 3 lines gaining international features (TravelPass + Global Choice + International Long Distance)
  • +$98.00 from 2 new smartphone lines on account …7281
  • +$67.21 from tax / surcharge increases on accounts …7281 and …4419

We flagged $274.50 as potentially disputable, mostly from the missing promo credits and a suspended line that's still being billed $45/mo.`}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                bill_comparison · 11111111
              </span>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                audit · current
              </span>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                audit · previous
              </span>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                finding · suspended_line_billed
              </span>
            </div>
          </div>
        </div>
        {/* User follow-up */}
        <div className="flex justify-end">
          <div className="max-w-2xl rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm text-white">
            Draft a dispute email for the missing promo credits.
          </div>
        </div>
        <div className="flex justify-start">
          <div className="max-w-3xl rounded-2xl rounded-bl-sm bg-neutral-50 px-4 py-3 text-sm text-neutral-900">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Suggested email
            </p>
            <pre className="mt-1 whitespace-pre-wrap font-sans leading-relaxed">
{`Subject: Billing dispute — missing BYOD Loyalty Bonus credits, April 2026

Hello,

Account ending …7281, invoice for April 2026. Eleven wireless lines
received a recurring "BYOD Loyalty Bonus" credit of $20.00/mo on prior
invoices but the credit disappeared on this cycle without a matching
device payoff, disconnect, plan change, or contract expiration.

Affected line last-4: *3300, *3301, *3302, *3303, *3304, *3305, *3306,
*3307, *3308, *3309, *3310.

Total requested credit for April: $220.00. Please apply a recurring
correction restoring the credit going forward, and back-credit the
April cycle.

Thanks,
[Your name]`}
            </pre>
          </div>
        </div>
        {/* Input */}
        <div className="flex items-center gap-2 border-t border-neutral-200 pt-4">
          <input
            type="text"
            disabled
            placeholder="Ask anything…"
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-neutral-400"
          />
          <button
            type="button"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
            disabled
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
