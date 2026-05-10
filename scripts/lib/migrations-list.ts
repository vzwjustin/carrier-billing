/**
 * scripts/lib/migrations-list.ts
 *
 * Lists Supabase migration files for the bootstrap script's operator-facing
 * print/dry-run output. Reads the directory at run time so the list never
 * drifts from what's on disk.
 *
 * Sorting is plain lexicographic, which is correct as long as filenames keep
 * a zero-padded numeric prefix (`0001_…`, `0010_…`, etc.) — see the unit test
 * in `tests/scripts/migrations-list.test.ts` that pins this invariant.
 */

import { readdir } from 'node:fs/promises';

/**
 * Read the migrations directory and return the `.sql` filenames, sorted.
 *
 * Fails loudly if the directory cannot be read — operators following the
 * bootstrap output need to know they're missing migrations rather than
 * silently deploying against an outdated list.
 */
export async function listMigrationFiles(
  migrationsDir: string,
): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}
