Wait, the `Next.js can't recognize the exported revalidate field` is likely because I can't use BOTH `export const revalidate = 3600;` and `export const dynamic = 'force-dynamic';` together in those image files. If it's `force-dynamic`, it cannot be revalidated on an interval.

Let's remove `export const revalidate = 3600;` from `src/app/share/[token]/opengraph-image.tsx` and `src/app/share/[token]/twitter-image.tsx`.
