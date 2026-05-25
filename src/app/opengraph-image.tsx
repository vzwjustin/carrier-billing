import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'CarrierAudit — Wireless bill audits with quantified savings, in minutes';

// Dynamic OpenGraph image — rendered at build time and edge-cached. Shown
// when the site is shared on Slack, LinkedIn, Twitter, iMessage, etc.
// Keep visual hierarchy: brand mark, headline, supporting line, footer chip.
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #064e3b 0%, #0f172a 75%, #020617 100%)',
          padding: '88px 96px',
          fontFamily: 'system-ui, sans-serif',
          color: 'white',
          position: 'relative',
        }}
      >
        {/* Top brand row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 'auto' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: '#10b981',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 32,
              fontWeight: 800,
              letterSpacing: '-0.05em',
              color: 'white',
              boxShadow: '0 12px 32px rgba(16, 185, 129, 0.5)',
            }}
          >
            CA
          </div>
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em' }}>
            CarrierAudit
          </div>
        </div>

        {/* Headline */}
        <div
          style={{
            fontSize: 80,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: '-0.04em',
            marginBottom: 28,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <span>Wireless bill audits</span>
          <span style={{ color: '#34d399' }}>with quantified savings.</span>
        </div>

        {/* Supporting line */}
        <div
          style={{
            fontSize: 30,
            fontWeight: 500,
            color: 'rgba(255,255,255,0.75)',
            maxWidth: 880,
            lineHeight: 1.35,
            marginBottom: 'auto',
          }}
        >
          Upload Verizon, AT&T, or T-Mobile bills. AI extracts every line, 10
          rules find the waste, you get a PDF report in under 5 minutes.
        </div>

        {/* Footer pills */}
        <div style={{ display: 'flex', gap: 16, fontSize: 22, fontWeight: 600 }}>
          {['Money-back guarantee', '18–32% typical savings', 'No carrier contact'].map((label) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '12px 22px',
                background: 'rgba(16, 185, 129, 0.15)',
                border: '2px solid rgba(16, 185, 129, 0.4)',
                borderRadius: 999,
                color: '#a7f3d0',
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
