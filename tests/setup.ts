import '@testing-library/jest-dom/vitest';

// Skip env validation during tests so src/env.ts doesn't fail when required
// vars are absent in the test environment.
process.env.SKIP_ENV_VALIDATION = '1';

// Provide harmless placeholders for any env accessed at module load time.
process.env.NEXT_PUBLIC_APP_URL ??= 'http://localhost:3000';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder';
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ??= 'pk_placeholder';
