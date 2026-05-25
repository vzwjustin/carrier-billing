import type { MetadataRoute } from 'next';

function appUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? 'https://carrieraudit.com';
  return raw.replace(/\/$/, '');
}

// The three seeded public-share sample audits — kept in sync with
// `scripts/seed-sample-audits.ts`. Bumping these here exposes them to
// search engines so prospects can discover the live audits via SEO.
const SAMPLE_SHARE_TOKENS = [
  'verizon_business_large_sample_v1',
  'att_business_multi_account_2026_',
  'tmobile_business_large_2026_demo',
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrl();
  const now = new Date();

  const marketing: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/login`, lastModified: now, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${base}/signup`, lastModified: now, changeFrequency: 'yearly', priority: 0.7 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];

  const samples: MetadataRoute.Sitemap = SAMPLE_SHARE_TOKENS.map((token) => ({
    url: `${base}/share/${token}`,
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.8,
  }));

  return [...marketing, ...samples];
}
