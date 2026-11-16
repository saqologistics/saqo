CREATE TABLE saqo.support_agent_heartbeats (
  profile_id text PRIMARY KEY REFERENCES saqo.profiles(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

REVOKE ALL ON saqo.support_agent_heartbeats FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saqo_app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON saqo.support_agent_heartbeats TO saqo_app_runtime;
  END IF;
END
$$;
