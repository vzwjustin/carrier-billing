'use server';

import { randomBytes } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { generateInboundToken } from '@/lib/inbound/token';
import {
  assertPublicHttpsTarget,
  SsrfBlockedError,
} from '@/lib/security/ssrf-guard';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const ProfileSchema = z.object({
  full_name: z.string().trim().max(120).optional().nullable(),
  company_name: z.string().trim().max(120).optional().nullable(),
});

export type UpdateProfileResult =
  | { ok: true }
  | { ok: false; error: string };

const WebhookSchema = z.object({
  outbound_webhook_url: z
    .string()
    .trim()
    .max(2048)
    .refine(
      (v) => v === '' || /^https:\/\//i.test(v),
      'URL must start with https://',
    ),
});

export type UpdateWebhookResult =
  | { ok: true }
  | { ok: false; error: string };

export type CopyWebhookSecretResult =
  | { ok: true; secret: string }
  | { ok: false; error: string };

export type RotateInboundTokenResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export async function updateProfileAction(
  input: unknown,
): Promise<UpdateProfileResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid input.' };
  }

  const admin = getAdminClient();
  const { error } = await admin
    .from('profiles')
    .update({
      full_name: parsed.data.full_name?.length ? parsed.data.full_name : null,
      company_name: parsed.data.company_name?.length
        ? parsed.data.company_name
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (error) {
    return { ok: false, error: 'Could not save profile. Please try again.' };
  }

  revalidatePath('/settings');
  return { ok: true };
}

export async function updateOutboundWebhookAction(
  input: unknown,
): Promise<UpdateWebhookResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const parsed = WebhookSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? 'Invalid URL.' };
  }

  const url = parsed.data.outbound_webhook_url.trim();
  const admin = getAdminClient();

  if (url === '') {
    // Clear webhook config + secret entirely.
    const { error } = await admin
      .from('profiles')
      .update({
        outbound_webhook_url: null,
        outbound_webhook_secret: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);
    if (error) return { ok: false, error: 'Could not save webhook.' };
    revalidatePath('/settings');
    return { ok: true };
  }

  // Reject loopback / private / IMDS / CGNAT / link-local destinations at
  // submit time so the user gets immediate feedback. The dispatcher
  // re-validates at delivery time to defeat DNS rebinding.
  try {
    await assertPublicHttpsTarget(url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return {
        ok: false,
        error:
          err.code === 'not_https'
            ? 'URL must start with https://'
            : 'URL must point to a public, internet-reachable host.',
      };
    }
    return { ok: false, error: 'Could not validate webhook URL.' };
  }

  // Generate a fresh signing secret only on first set OR if explicitly
  // rotated. Otherwise leave the existing one alone so the user's existing
  // verifier doesn't break when they edit the URL.
  const existing = await admin
    .from('profiles')
    .select('outbound_webhook_secret')
    .eq('id', user.id)
    .maybeSingle();
  const currentSecret = (
    existing.data as { outbound_webhook_secret?: string | null } | null
  )?.outbound_webhook_secret;
  const secret =
    typeof currentSecret === 'string' && currentSecret.length > 0
      ? currentSecret
      : `whs_${randomBytes(24).toString('hex')}`;

  const { error } = await admin
    .from('profiles')
    .update({
      outbound_webhook_url: url,
      outbound_webhook_secret: secret,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (error) return { ok: false, error: 'Could not save webhook.' };
  revalidatePath('/settings');
  return { ok: true };
}

export async function copyOutboundWebhookSecretAction(): Promise<CopyWebhookSecretResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const admin = getAdminClient();
  const { data, error } = await admin
    .from('profiles')
    .select('outbound_webhook_secret')
    .eq('id', user.id)
    .maybeSingle();

  if (error) return { ok: false, error: 'Could not retrieve secret.' };
  const secret = (data as { outbound_webhook_secret?: string | null } | null)
    ?.outbound_webhook_secret;
  if (typeof secret !== 'string' || secret.length === 0) {
    return { ok: false, error: 'No secret configured.' };
  }
  return { ok: true, secret };
}

export async function rotateInboundTokenAction(): Promise<RotateInboundTokenResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const admin = getAdminClient();
  // Retry on Postgres unique-constraint violation (23505): with a 16-char
  // base32 token (~80 bits of entropy) collisions are astronomically rare,
  // but we'd rather fail loud + retry than corrupt the user's token.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = generateInboundToken();
    const { error } = await admin
      .from('profiles')
      .update({
        inbound_email_token: fresh,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (!error) {
      revalidatePath('/settings');
      return { ok: true, token: fresh };
    }

    if ((error as { code?: string }).code !== '23505') {
      return { ok: false, error: 'Could not rotate token.' };
    }
    // 23505 → token collision; loop for another attempt.
  }
  return { ok: false, error: 'Could not rotate token. Please try again.' };
}
