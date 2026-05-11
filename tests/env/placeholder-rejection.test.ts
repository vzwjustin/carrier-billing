import { describe, expect, it } from 'vitest';

import {
  REQUIRED_SERVER_SECRETS,
  assertNoPlaceholderSecrets,
  isPlaceholderSecret,
} from '@/env';

const REAL_VALUES: Record<(typeof REQUIRED_SERVER_SECRETS)[number], string> = {
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.real-service-role-token',
  ANTHROPIC_API_KEY: 'sk-ant-api03-real-key',
  AWS_ACCESS_KEY_ID: 'AKIAREALACCESSKEYID0',
  AWS_SECRET_ACCESS_KEY: 'aws-real-secret-access-key-0123456789abcdef',
  STRIPE_SECRET_KEY: 'sk_test_realstripesecret',
  STRIPE_WEBHOOK_SECRET: 'whsec_realwebhooksecret',
  STRIPE_PRICE_ID_ONE_TIME: 'price_1RealOneTime',
  STRIPE_PRICE_ID_SUBSCRIPTION: 'price_1RealSubscription',
  RESEND_API_KEY: 're_realresendkey',
  INNGEST_EVENT_KEY: 'evt-real-inngest-event-key',
  INNGEST_SIGNING_KEY: 'signkey-real-inngest-signing-key',
};

function buildEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...REAL_VALUES, ...overrides } as unknown as NodeJS.ProcessEnv;
}

describe('isPlaceholderSecret', () => {
  it.each([
    'placeholder',
    'PLACEHOLDER',
    'sk_placeholder',
    'whsec_placeholder',
    'price_placeholder',
    'changeme',
    'change-me',
    'replace-me',
    'replaceme',
    '__missing_at_build_time__',
    '__MISSING_AT_BUILD_TIME__',
  ])('flags %j as a placeholder', (value) => {
    expect(isPlaceholderSecret(value)).toBe(true);
  });

  it.each([
    'sk_test_dXfulOKlbz2OsU6Jua46YSu5',
    'eyJhbGciOiJSUzI1NiI',
    'AKIAIOSFODNN7EXAMPLE',
    'whsec_realsecret',
    'price_1ABCDEF',
  ])('does not flag %j', (value) => {
    expect(isPlaceholderSecret(value)).toBe(false);
  });

  it('treats empty / undefined values as non-placeholder (handled by Zod min(1))', () => {
    expect(isPlaceholderSecret(undefined)).toBe(false);
    expect(isPlaceholderSecret('')).toBe(false);
  });
});

describe('assertNoPlaceholderSecrets', () => {
  it('passes when every required server secret has a real value', () => {
    expect(() => assertNoPlaceholderSecrets(buildEnv())).not.toThrow();
  });

  it.each(REQUIRED_SERVER_SECRETS)(
    'throws when %s is set to "placeholder"',
    (key) => {
      const env = buildEnv({ [key]: 'placeholder' });
      expect(() => assertNoPlaceholderSecrets(env)).toThrow(
        new RegExp(`placeholder values detected.*${key}`, 'i'),
      );
    },
  );

  it.each([
    'sk_placeholder',
    'whsec_placeholder',
    'price_placeholder',
    'changeme',
    'replace-me',
    '__MISSING_AT_BUILD_TIME__',
  ])('rejects placeholder variant %j', (variant) => {
    const env = buildEnv({ STRIPE_SECRET_KEY: variant });
    expect(() => assertNoPlaceholderSecrets(env)).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('lists every offending key in a single error', () => {
    const env = buildEnv({
      ANTHROPIC_API_KEY: 'placeholder',
      RESEND_API_KEY: 'placeholder',
    });
    expect(() => assertNoPlaceholderSecrets(env)).toThrow(
      /ANTHROPIC_API_KEY.*RESEND_API_KEY|RESEND_API_KEY.*ANTHROPIC_API_KEY/,
    );
  });

  it('ignores absent optional secrets (treated as not-placeholder)', () => {
    const env = buildEnv({
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    });
    expect(() => assertNoPlaceholderSecrets(env)).not.toThrow();
  });
});
