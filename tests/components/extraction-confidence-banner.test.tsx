import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ExtractionConfidenceBanner } from '@/components/report/extraction-confidence-banner';

/**
 * The banner is a pure presentational guard: it renders a caution notice only
 * when the persisted bill-level extraction confidence was downgraded
 * ('medium' / 'low'), and nothing at all for the clean-parse cases ('high' /
 * null) so a confident report shows no chrome.
 */
describe('ExtractionConfidenceBanner', () => {
  it('renders nothing for high confidence', () => {
    const { container } = render(
      <ExtractionConfidenceBanner confidence="high" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for null (pre-migration rows)', () => {
    const { container } = render(
      <ExtractionConfidenceBanner confidence={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for an unexpected value', () => {
    const { container } = render(
      <ExtractionConfidenceBanner confidence="bogus" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders an amber caution banner for medium confidence', () => {
    const { container, getByText } = render(
      <ExtractionConfidenceBanner confidence="medium" />,
    );
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.className).toContain('amber');
    expect(getByText(/Extraction confidence: medium/i)).toBeTruthy();
    expect(getByText(/double-check key figures/i)).toBeTruthy();
  });

  it('renders a red caution banner for low confidence', () => {
    const { container, getByText } = render(
      <ExtractionConfidenceBanner confidence="low" />,
    );
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.className).toContain('red');
    expect(getByText(/verify before relying on these figures/i)).toBeTruthy();
  });

  it('exposes a status role for assistive tech', () => {
    const { getByRole } = render(
      <ExtractionConfidenceBanner confidence="low" />,
    );
    expect(getByRole('status')).toBeTruthy();
  });
});
