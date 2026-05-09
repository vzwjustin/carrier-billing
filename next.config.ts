import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

// Content-Security-Policy is set in `src/middleware.ts`. The other security
// headers are static and set here.
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

// Sourcemap upload + release tracking is opt-in via SENTRY_UPLOAD=1 plus a
// valid token/org/project. Default OFF because:
//   - PR builds + forks can have stale/missing Sentry secrets that 401 the
//     upload and fail the entire build (`sentry-cli releases new` exits 1)
//   - Source maps for an ephemeral preview deploy aren't useful anyway
// Production deploys flip SENTRY_UPLOAD=1 in their build env.
const sentryUploadEnabled =
  process.env.SENTRY_UPLOAD === '1' &&
  Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);

export default withSentryConfig(nextConfig, {
  org: sentryUploadEnabled ? process.env.SENTRY_ORG : undefined,
  project: sentryUploadEnabled ? process.env.SENTRY_PROJECT : undefined,
  // Withholding authToken when not opted in is the most reliable way to make
  // the wrapper skip every CLI call — sourcemap upload, release create, and
  // release finalize all gate on it.
  authToken: sentryUploadEnabled ? process.env.SENTRY_AUTH_TOKEN : undefined,
  silent: !sentryUploadEnabled,
  sourcemaps: { disable: !sentryUploadEnabled },
  release: {
    create: sentryUploadEnabled,
    finalize: sentryUploadEnabled,
  },
  widenClientFileUpload: true,
  reactComponentAnnotation: { enabled: true },
  tunnelRoute: '/monitoring',
  hideSourceMaps: true,
  disableLogger: true,
  automaticVercelMonitors: false,
});
