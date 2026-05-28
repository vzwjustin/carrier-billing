// Stub for Next.js' `server-only` package.
//
// The real package exports nothing useful — it exists only to throw at
// runtime if a server-only module ever ends up in a client bundle.
// Vite can't resolve the bare module name during test transform, so we
// alias it here to a harmless empty module.
export {};
