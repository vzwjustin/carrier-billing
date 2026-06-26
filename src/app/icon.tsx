import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

// Dynamic favicon — emerald "CA" monogram on a square tile. Generated at
// build time by Next.js, served as PNG. Keeps the brand consistent without
// needing static icon assets in the repo.
export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        fontSize: 22,
        background: '#10b981',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontWeight: 800,
        letterSpacing: '-0.05em',
        fontFamily: 'system-ui, sans-serif',
        borderRadius: '8px',
      }}
    >
      CA
    </div>,
    {
      ...size,
    },
  );
}
