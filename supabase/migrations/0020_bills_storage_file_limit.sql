-- Enforce the bill-upload byte cap at Supabase Storage, not only in the
-- client/API metadata path. The signed-upload route still validates the
-- claimed size, but this bucket limit is the authoritative server-side guard.

update storage.buckets
   set file_size_limit = 26214400
 where id = 'bills';
