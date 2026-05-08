/**
 * scripts/lib/supabase-helpers.ts
 *
 * Idempotent Supabase storage bucket helper. Uses the service-role admin
 * client; never call from a browser surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type EnsureBucketResult = {
  name: string;
  created: boolean;
};

/**
 * List buckets and create `name` (private) if it doesn't exist.
 * Returns whether the bucket was newly created.
 */
export async function ensureBucket(
  supabase: SupabaseClient,
  name: string,
): Promise<EnsureBucketResult> {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    throw new Error(`Failed to list Supabase buckets: ${listError.message}`);
  }

  const exists = buckets?.some((b) => b.name === name) ?? false;
  if (exists) {
    return { name, created: false };
  }

  const { error: createError } = await supabase.storage.createBucket(name, {
    public: false,
  });
  if (createError) {
    // Race condition: another process may have created it between list+create.
    if (createError.message.toLowerCase().includes('already exists')) {
      return { name, created: false };
    }
    throw new Error(`Failed to create bucket "${name}": ${createError.message}`);
  }

  return { name, created: true };
}
