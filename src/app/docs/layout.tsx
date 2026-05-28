import type { Metadata } from 'next';

import { DocsNav } from '@/components/docs/docs-nav';
import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteNav } from '@/components/marketing/site-nav';

export const metadata: Metadata = {
  title: 'Documentation — CarrierAudit',
  description:
    'How to upload a bill, what the rules engine looks for, how the Bill Increase Autopsy works, and how to file a dispute packet with your carrier.',
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex min-h-screen flex-col bg-white text-neutral-900">
      <SiteNav />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-4 py-12 lg:grid-cols-[200px_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <DocsNav />
          </aside>
          <article className="min-w-0">{children}</article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
