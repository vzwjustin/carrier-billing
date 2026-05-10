/**
 * Tests for the root app layout (`src/app/layout.tsx`) and the PostHogProvider
 * mount point.
 *
 *  - Confirms that the root layout wraps its children with PostHogProvider so
 *    client-side analytics (`$pageview`, `audit_uploaded`, `checkout_started`)
 *    actually fire.
 *  - Confirms that PostHogProvider stays a transparent passthrough when the
 *    public PostHog key is absent (local dev / test) and on the public
 *    `/share/*` surface (anonymous-token territory; client analytics are off
 *    by design — see C4 / H14).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const setPathname = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => setPathname(),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/posthog/client', () => ({
  initPostHog: vi.fn(),
}));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/components/posthog-provider');
  vi.unstubAllEnvs();
  setPathname.mockReset();
});

describe('RootLayout', () => {
  beforeEach(() => {
    setPathname.mockReturnValue('/dashboard');
  });

  it('wraps children with PostHogProvider', async () => {
    vi.doMock('@/components/posthog-provider', () => ({
      PostHogProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="posthog-provider">{children}</div>
      ),
    }));

    const { default: RootLayout } = await import('@/app/layout');

    const html = renderToStaticMarkup(
      <RootLayout>
        <span data-testid="layout-child">marker</span>
      </RootLayout>,
    );

    expect(html).toContain('data-testid="posthog-provider"');
    expect(html).toContain('data-testid="layout-child"');
    // Children must be inside the provider, not adjacent to it.
    const providerIdx = html.indexOf('data-testid="posthog-provider"');
    const childIdx = html.indexOf('data-testid="layout-child"');
    expect(providerIdx).toBeGreaterThan(-1);
    expect(childIdx).toBeGreaterThan(providerIdx);
  });
});

describe('PostHogProvider', () => {
  it('renders children unchanged when NEXT_PUBLIC_POSTHOG_KEY is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    setPathname.mockReturnValue('/dashboard');

    const { PostHogProvider } = await import('@/components/posthog-provider');
    const { initPostHog } = await import('@/lib/posthog/client');

    const html = renderToStaticMarkup(
      <PostHogProvider>
        <span data-testid="child">hello</span>
      </PostHogProvider>,
    );

    expect(html).toContain('data-testid="child"');
    expect(html).toContain('hello');
    expect(vi.mocked(initPostHog)).not.toHaveBeenCalled();
  });

  it('skips analytics on /share/* paths even when the key is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');
    setPathname.mockReturnValue('/share/abc123');

    const { PostHogProvider } = await import('@/components/posthog-provider');
    const { initPostHog } = await import('@/lib/posthog/client');

    const html = renderToStaticMarkup(
      <PostHogProvider>
        <span data-testid="share-child">shared report</span>
      </PostHogProvider>,
    );

    expect(html).toContain('data-testid="share-child"');
    // PostHogInner renders a Suspense fallback wrapper; the no-op branch must
    // not render anything beyond the children.
    expect(html).toBe('<span data-testid="share-child">shared report</span>');
    expect(vi.mocked(initPostHog)).not.toHaveBeenCalled();
  });
});
