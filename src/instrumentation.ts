// Next.js 15 instrumentation hook. Loads the appropriate Sentry config
// for whichever runtime the request is being served from.
//
// See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Re-export Sentry's request error capture so Next.js will forward
// unhandled request errors to Sentry. Lazy import keeps this module light.
type CaptureRequestErrorParams = Parameters<
  typeof import('@sentry/nextjs').captureRequestError
>;

export async function onRequestError(...args: CaptureRequestErrorParams): Promise<void> {
  const { captureRequestError } = await import('@sentry/nextjs');
  await captureRequestError(...args);
}
