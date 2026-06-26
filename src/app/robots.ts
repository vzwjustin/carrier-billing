import type { MetadataRoute } from 'next';

function appUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? 'https://carrieraudit.com';
  return raw.replace(/\/$/, '');
}

export default function robots(): MetadataRoute.Robots {
  const base = appUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/login', '/signup', '/pricing', '/privacy', '/terms', '/share/'],
        disallow: ['/api/', '/admin/', '/dashboard/', '/audits/', '/settings/', '/monitoring/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
