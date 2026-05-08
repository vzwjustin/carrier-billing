/**
 * scripts/lib/env-loader.ts
 *
 * Tiny .env.local parser used by bootstrap.ts. We deliberately do NOT merge
 * into process.env — callers receive the parsed map and decide what to do.
 *
 * Format supported:
 *   KEY=VALUE
 *   KEY="quoted value"
 *   KEY='single quoted'
 *   # comment lines and blank lines are ignored
 *   trailing # comments after unquoted values are stripped
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export type EnvMap = Record<string, string>;

/**
 * Parse `.env.local` from the given project root (defaults to cwd).
 * Returns an empty object if the file is missing.
 */
export function loadDotEnvLocal(projectRoot: string = process.cwd()): EnvMap {
  const filePath = path.join(projectRoot, '.env.local');
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  const result: EnvMap = {};
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      } else {
        // strip trailing inline `# comment` only when unquoted
        const hashIdx = value.indexOf(' #');
        if (hashIdx >= 0) {
          value = value.slice(0, hashIdx).trim();
        }
      }
    }

    if (key.length > 0) {
      result[key] = value;
    }
  }

  return result;
}
