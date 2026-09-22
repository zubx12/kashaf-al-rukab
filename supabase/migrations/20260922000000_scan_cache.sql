-- Persistent scan cache: stores AI extraction results keyed by image hash.
-- Eliminates redundant Gemini API calls when the same document is scanned again
-- (e.g. same passport across trips, shared passenger list scanned by multiple drivers).
-- 24-hour TTL auto-expires entries; cron cleanup is optional.

CREATE TABLE IF NOT EXISTS scan_cache (
  image_hash  TEXT PRIMARY KEY,
  result      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

-- Index for efficient expired-entry cleanup
CREATE INDEX idx_scan_cache_expires ON scan_cache (expires_at);

-- RLS: this table is only accessed via service_role (admin client) in the API route.
-- Enable RLS but add no public policies — anon/authenticated cannot touch it.
ALTER TABLE scan_cache ENABLE ROW LEVEL SECURITY;

-- Service-role bypass: the admin client uses the service_role key which has
-- bypassrls, so no explicit policy is needed for server-side access.
