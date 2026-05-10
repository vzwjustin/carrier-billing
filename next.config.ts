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

// Routes whose URL embeds a share token (either in the path, like /share/<token>,
// or in a query string, like /api/audits/.../report.pdf?token=...) must not
// leak that token via the Referer header — not even on same-origin navigation.
// When two header entries match the same path and set the same key, the later
// entry wins, so this overrides Referrer-Policy from SECURITY_HEADERS for these
// routes only.
const NO_REFERRER_HEADER = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

export const headersConfig = [
  {
    source: '/:path*',
    headers: SECURITY_HEADERS,
  },
  {
    source: '/share/:path*',
    headers: NO_REFERRER_HEADER,
  },
  {
    source: '/api/audits/:id*/report.pdf',
    headers: NO_REFERRER_HEADER,
  },
];

export const nextConfig: NextConfig = {
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
    return headersConfig;
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
  Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
      process.env.SENTRY_ORG &&
      process.env.SENTRY_PROJECT,
  );

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
