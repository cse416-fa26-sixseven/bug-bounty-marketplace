-- Sessions ended by POST /api/auth/logout. A session cookie is signed and
-- carries a random session id; one whose id is listed here is refused, so a
-- copied cookie stops working at logout and stays refused across API restarts
-- and replicas. expires_at is the cookie's own expiry: after it the cookie is
-- refused anyway, so each logout deletes the rows that have passed it. The
-- table stays small (rows live at most the 8-hour session lifetime), so it
-- has no index besides the key. CREATE TABLE IF NOT EXISTS takes no lock on
-- an existing table, so re-running on every boot is safe.

CREATE TABLE IF NOT EXISTS revoked_sessions (
  session_id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL
);
