import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listMigrationFiles } from '../../scripts/lib/migrations-list';

describe('listMigrationFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'migrations-list-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns .sql files sorted lexicographically (correct for zero-padded prefixes)', async () => {
    await writeFile(path.join(dir, '0010_late.sql'), '');
    await writeFile(path.join(dir, '0002_storage.sql'), '');
    await writeFile(path.join(dir, '0001_init.sql'), '');
    await writeFile(path.join(dir, '0009_bill_indexes.sql'), '');

    const result = await listMigrationFiles(dir);

    expect(result).toEqual([
      '0001_init.sql',
      '0002_storage.sql',
      '0009_bill_indexes.sql',
      '0010_late.sql',
    ]);
  });

  it('filters out non-sql files', async () => {
    await writeFile(path.join(dir, '0001_init.sql'), '');
    await writeFile(path.join(dir, 'README.md'), '');
    await writeFile(path.join(dir, '0002_storage.sql.bak'), '');

    const result = await listMigrationFiles(dir);

    expect(result).toEqual(['0001_init.sql']);
  });

  it('returns an empty array when no .sql files are present', async () => {
    await writeFile(path.join(dir, 'notes.txt'), '');
    const result = await listMigrationFiles(dir);
    expect(result).toEqual([]);
  });

  it('throws if the directory does not exist (fail-loud, no fallback)', async () => {
    const missing = path.join(dir, 'does-not-exist');
    await expect(listMigrationFiles(missing)).rejects.toThrow();
  });
});
