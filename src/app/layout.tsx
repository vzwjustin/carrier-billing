import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

import { PostHogProvider } from '@/components/posthog-provider';
import { ThemeScript } from '@/components/theme/theme-script';

function metadataBase(): URL | undefined {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBase(),
  title: {
    default: 'CarrierAudit — Wireless Bill Audits in Minutes',
    template: '%s — CarrierAudit',
  },
  description:
    'Upload your business wireless bill (Verizon, AT&T, T-Mobile) and get a professional audit with quantified savings in under 5 minutes. Money-back guarantee.',
  keywords: [
    'wireless bill audit',
    'verizon business audit',
    'att business audit',
    't-mobile business audit',
    'cell phone bill audit',
    'telecom expense management',
    'wireless cost reduction',
    'business wireless audit',
    'phone bill audit service',
  ],
  openGraph: {
    title: 'CarrierAudit — Wireless Bill Audits in Minutes',
    description:
      "Find the 18-32% you're overpaying on Verizon, AT&T, and T-Mobile business bills. Money-back guarantee.",
    type: 'website',
    siteName: 'CarrierAudit',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CarrierAudit — Wireless Bill Audits in Minutes',
    description:
      "Find the 18-32% you're overpaying on business wireless bills.",
  },
  alternates: {
    canonical: '/',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-snippet': -1,
      'max-image-preview': 'large',
    },
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen antialiased">
        <PostHogProvider>{children}</PostHogProvider>
        <Toaster richColors position="top-center" closeButton />
      </body>
    </html>
  );
}
