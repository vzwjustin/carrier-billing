-- Enforce upload limits on the existing private bills bucket.
-- Supabase Storage applies these bucket settings before objects are accepted,
-- preserving the bucket and its existing RLS policies.

update storage.buckets
set
  file_size_limit = 26214400,
  -- Accept PDFs and common EDI/X12 text-ish uploads. Some EDI senders use
  -- application/octet-stream or text/plain depending on browser/OS sniffing;
  -- keep the allowlist broad enough for the supported EDI path while still
  -- excluding obvious non-document uploads at the storage edge.
  allowed_mime_types = array[
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/edi-x12',
    'application/edifact',
    'application/octet-stream'
  ]
where id = 'bills';
