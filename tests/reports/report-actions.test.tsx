import { fireEvent, render, screen } from '@testing-library/react';
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ReportActions } from '@/components/report/report-actions';

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

describe('ReportActions', () => {
  it('adds the public share token to PDF downloads for public reports', () => {
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <ReportActions
        auditId="11111111-1111-4111-8111-111111111111"
        isPublic
        shareToken="token with spaces"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));

    expect(openMock).toHaveBeenCalledWith(
      '/api/audits/11111111-1111-4111-8111-111111111111/report.pdf?token=token%20with%20spaces',
      '_blank',
      'noopener',
    );
  });
});
