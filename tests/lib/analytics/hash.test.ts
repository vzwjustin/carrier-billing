import { describe, expect, it } from 'vitest';

import { hashTokenForAnalytics } from '@/lib/analytics/hash';

describe('hashTokenForAnalytics', () => {
  it('returns a string prefixed with share_', () => {
    const result = hashTokenForAnalytics('abc123token');
    expect(result.startsWith('share_')).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const token = 'some-share-token-xyz';
    expect(hashTokenForAnalytics(token)).toBe(hashTokenForAnalytics(token));
  });

  it('produces different outputs for different inputs', () => {
    expect(hashTokenForAnalytics('token-a')).not.toBe(
      hashTokenForAnalytics('token-b'),
    );
  });

  it('never contains the original token substring', () => {
    const token = 'supersecretshareTOKEN1234567890';
    const hashed = hashTokenForAnalytics(token);
    expect(hashed.includes(token)).toBe(false);
    expect(hashed.includes('supersecret')).toBe(false);
  });

  it('returns share_ followed by 16 hex chars', () => {
    const result = hashTokenForAnalytics('any-token');
    expect(result).toMatch(/^share_[0-9a-f]{16}$/);
  });
});
