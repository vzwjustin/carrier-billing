/**
 * scripts/configure-textract-bucket.ts
 *
 * Idempotently apply the lifecycle policy that expires staged Textract PDFs
 * after 1 day. The async OCR path (`src/extraction/ocr.ts`) uploads PDFs to
 * `s3://${AWS_TEXTRACT_S3_BUCKET}/carrieraudit/textract-staging/<uuid>.pdf`
 * and tries to delete each one in `finally`. If that delete fails (network
 * blip, IAM drift, lambda crash) the object becomes an orphan — the
 * lifecycle policy is the safety net.
 *
 * Usage:
 *   pnpm tsx scripts/configure-textract-bucket.ts            # apply
 *   pnpm tsx scripts/configure-textract-bucket.ts --dry-run  # print only
 *
 * Env (read from .env.local — same loader as bootstrap.ts):
 *   AWS_REGION                 (default us-east-1)
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_TEXTRACT_S3_BUCKET
 *
 * Re-running the script is safe: PutBucketLifecycleConfiguration replaces
 * the entire ruleset on the bucket. We fetch the current configuration
 * first and merge our rule (matched by RuleId `carrieraudit-textract-staging-expire-1d`)
 * so any unrelated rules on the bucket are preserved.
 *
 * Equivalent aws-cli (for the runbook):
 *   aws s3api put-bucket-lifecycle-configuration \
 *     --bucket "$AWS_TEXTRACT_S3_BUCKET" \
 *     --lifecycle-configuration file://lifecycle.json
 *
 *   # lifecycle.json:
 *   {
 *     "Rules": [{
 *       "ID": "carrieraudit-textract-staging-expire-1d",
 *       "Status": "Enabled",
 *       "Filter": { "Prefix": "carrieraudit/textract-staging/" },
 *       "Expiration": { "Days": 1 },
 *       "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
 *     }]
 *   }
 */

import {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';

import { loadDotEnvLocal } from './lib/env-loader';

const RULE_ID = 'carrieraudit-textract-staging-expire-1d';
const PREFIX = 'carrieraudit/textract-staging/';
const EXPIRE_DAYS = 1;

const desiredRule: LifecycleRule = {
  ID: RULE_ID,
  Status: 'Enabled',
  Filter: { Prefix: PREFIX },
  Expiration: { Days: EXPIRE_DAYS },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: EXPIRE_DAYS },
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  if (argv.includes('-h') || argv.includes('--help')) {
    printUsage();
    return;
  }

  const fileEnv = loadDotEnvLocal();
  const env = { ...fileEnv, ...process.env } as Record<string, string | undefined>;

  const region = env.AWS_REGION ?? 'us-east-1';
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const bucket = env.AWS_TEXTRACT_S3_BUCKET;

  const missing: string[] = [];
  if (!accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
  if (!bucket) missing.push('AWS_TEXTRACT_S3_BUCKET');
  if (missing.length > 0) {
    console.error(
      `[ERROR] Missing required env: ${missing.join(', ')}. Set in .env.local.`,
    );
    process.exit(1);
  }

  console.log(`Bucket:   ${bucket}`);
  console.log(`Region:   ${region}`);
  console.log(`Rule:     ${RULE_ID}`);
  console.log(`Prefix:   ${PREFIX}`);
  console.log(`Expires:  ${EXPIRE_DAYS} day(s)`);
  console.log('');

  if (dryRun) {
    console.log('[DRY-RUN] Would PutBucketLifecycleConfiguration with:');
    console.log(JSON.stringify({ Rules: [desiredRule] }, null, 2));
    return;
  }

  const s3 = new S3Client({
    region,
    credentials: {
      accessKeyId: accessKeyId as string,
      secretAccessKey: secretAccessKey as string,
    },
  });

  // Preserve any existing rules; replace ours by RuleId.
  let existing: LifecycleRule[] = [];
  try {
    const cfg = await s3.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    existing = cfg.Rules ?? [];
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).name
      ?? (err as { name?: string; Code?: string }).Code;
    if (code !== 'NoSuchLifecycleConfiguration') {
      throw err;
    }
    // No prior config — fine, we'll create one.
  }

  const merged = [
    desiredRule,
    ...existing.filter((r) => r.ID !== RULE_ID),
  ];

  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: merged },
    }),
  );

  console.log(
    `[OK] Lifecycle rule "${RULE_ID}" applied (${merged.length} rule(s) total on bucket).`,
  );
}

function printUsage(): void {
  console.log(
    `Usage: pnpm tsx scripts/configure-textract-bucket.ts [--dry-run]\n\n` +
      `Applies the textract-staging lifecycle rule to AWS_TEXTRACT_S3_BUCKET.\n` +
      `Idempotent. Preserves any unrelated rules already on the bucket.\n`,
  );
}

main().catch((err: unknown) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
