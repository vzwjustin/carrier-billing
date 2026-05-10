import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

import { PostHogProvider } from '@/components/posthog-provider';

export const metadata: Metadata = {
  title: 'CarrierAudit — Wireless Bill Audits in Minutes',
  description:
    'Upload your business wireless bill (Verizon, AT&T, T-Mobile) and get a professional audit with quantified savings in under 5 minutes.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <PostHogProvider>{children}</PostHogProvider>
        <Toaster richColors position="top-center" closeButton />
      </body>
    </html>
  );
}
