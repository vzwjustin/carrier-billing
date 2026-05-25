/**
 * /assistant — full-page chat with the CarrierAudit AI analyst.
 *
 * Server-component shell. Auth is already enforced by the (app)/layout.tsx
 * redirect — by the time this renders we know we have a logged-in user.
 * The client component handles all interaction state; the server does
 * nothing more than wire the page header.
 */

import { AssistantChat } from '@/components/assistant/assistant-chat';

export const dynamic = 'force-dynamic';

export default function AssistantPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Assistant
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Ask questions about your audits, findings, and bill comparisons. The
          assistant cites the underlying data and tells you when something
          isn&apos;t there.
        </p>
      </header>
      <AssistantChat />
    </div>
  );
}
