// Twitter / X card uses the same renderer as OG. Re-export for Next's
// metadata convention (./twitter-image picks up automatically alongside
// ./opengraph-image, no metadata wiring required).
export { default, size, contentType, alt, revalidate } from './opengraph-image';
