-- M-2 — Belt-and-suspenders CHECK constraint on audits.storage_path.
--
-- The upload route already validates the path shape against the same regex
-- (see src/app/api/audits/route.ts STORAGE_PATH_RE), but enforcing it at the
-- database layer keeps any future writer (worker, repair script, etc.) honest
-- and surfaces a hard error if the format ever drifts.
--
-- Path layout: `<userUuid>/<auditUuid>/<safeFilename>` where the filename has
-- already been passed through safeFilename() (only A-Z, a-z, 0-9, '.', '_', '-').
ALTER TABLE audits
  ADD CONSTRAINT audits_storage_path_format
  CHECK (storage_path ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}/[A-Za-z0-9._-]+$');
