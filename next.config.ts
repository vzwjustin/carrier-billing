import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

// Content-Security-Policy is set per-request in `src/middleware.ts` so each
// response carries a fresh nonce. The other security headers are static and
// set here.
const SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '30mb',
    },
  },
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist'],
  images: {
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // `silent: true` when the auth token is absent makes the wrapper skip
  // sourcemap upload (it has nothing to authenticate with) and suppress
  // its own logging. Keeps local dev + unauth'd CI from failing.
  silent: !process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  reactComponentAnnotation: { enabled: true },
  tunnelRoute: '/monitoring',
  hideSourceMaps: true,
  disableLogger: true,
  automaticVercelMonitors: false,
});
