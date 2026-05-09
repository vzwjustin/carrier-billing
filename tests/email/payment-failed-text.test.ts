import { describe, expect, it } from 'vitest';

import type { PaymentFailedEmailProps } from '@/lib/email/payment-failed';
import { renderPaymentFailedText } from '@/lib/email/payment-failed-text';

describe('renderPaymentFailedText', () => {
  const props: PaymentFailedEmailProps = {
    customerEmail: 'paying@example.com',
    recoveryUrl: 'https://app.example.com/billing/past-due',
    amountDueCents: 4900,
    invoiceId: 'in_1NaBcDeFgHiJkLmNoP',
  };

  it('includes the recovery URL', () => {
    const out = renderPaymentFailedText(props);
    expect(out).toContain('https://app.example.com/billing/past-due');
  });

  it('includes the formatted amount due', () => {
    const out = renderPaymentFailedText(props);
    expect(out).toContain('$49.00');
  });

  it('includes only the last 6 chars of the invoice id', () => {
    const out = renderPaymentFailedText(props);
    expect(out).toContain('…kLmNoP');
    expect(out).not.toContain('in_1NaBcD');
  });

  it('omits amount when null', () => {
    const out = renderPaymentFailedText({ ...props, amountDueCents: null });
    expect(out).not.toContain('Amount due');
  });

  it('omits invoice reference when invoiceId is null', () => {
    const out = renderPaymentFailedText({ ...props, invoiceId: null });
    expect(out).not.toContain('Invoice reference');
  });

  it('mentions past_due / payment failed in the body', () => {
    const out = renderPaymentFailedText(props);
    expect(out.toLowerCase()).toContain('past due');
  });
});
