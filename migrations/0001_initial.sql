-- OpenRampart initial schema.
-- Migrations are plain SQL, applied in filename order by src/server/migrate.ts.
-- See docs/migrations.md.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts and authentication
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{3,64}$'),
  email text CHECK (email IS NULL OR length(email) <= 320),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  password_hash text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'Europe/London',
  totp_secret_enc text,
  totp_pending_secret_enc text,
  totp_enabled_at timestamptz,
  totp_last_step bigint,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  last_login_ip text,
  last_login_user_agent text,
  previous_login_at timestamptz,
  previous_login_ip text,
  failed_login_count integer NOT NULL DEFAULT 0,
  last_failed_login_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hmac text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE UNIQUE INDEX recovery_codes_user_code_idx ON recovery_codes (user_id, code_hmac);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('mfa', 'totp_setup', 'active')),
  mfa_method text CHECK (mfa_method IN ('totp', 'recovery_code')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Used by rate-limiter-flexible (RateLimiterPostgres, tableCreated: true).
CREATE TABLE rate_limits (
  key varchar(255) PRIMARY KEY,
  points integer NOT NULL DEFAULT 0,
  expire bigint
);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE system_keys (
  id text PRIMARY KEY,
  value_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Record: event types, actors, events, incidents, attachments
-- ---------------------------------------------------------------------------

CREATE TABLE event_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]{2,64}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '',
  default_direction text CHECK (default_direction IN ('inbound', 'outbound', 'internal')),
  is_builtin boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'organisation' CHECK (kind IN ('organisation', 'person', 'other')),
  aliases text[] NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  account_reference text,
  website text,
  email text,
  phone text,
  address text,
  archived_at timestamptz,
  merged_into_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  merged_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  purge_after timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector
);
CREATE INDEX actors_owner_idx ON actors (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX actors_search_idx ON actors USING gin (search_vector);
CREATE INDEX actors_name_trgm_idx ON actors USING gin (name gin_trgm_ops);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL REFERENCES event_types(id),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 300),
  occurred_at timestamptz NOT NULL,
  occurred_precision text NOT NULL DEFAULT 'datetime' CHECK (occurred_precision IN ('date', 'datetime')),
  ended_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  direction text CHECK (direction IN ('inbound', 'outbound', 'internal')),
  description text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  risk_level text NOT NULL DEFAULT 'none' CHECK (risk_level IN ('none', 'low', 'medium', 'high')),
  risk_note text,
  amount numeric(14, 2),
  currency char(3),
  reference text,
  due_on date,
  revision integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_via text NOT NULL DEFAULT 'web' CHECK (created_via IN ('web', 'mcp', 'audit', 'import')),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  purge_after timestamptz,
  search_vector tsvector,
  CHECK (ended_at IS NULL OR ended_at >= occurred_at)
);
CREATE INDEX events_owner_occurred_idx ON events (owner_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX events_search_idx ON events USING gin (search_vector);
CREATE INDEX events_title_trgm_idx ON events USING gin (title gin_trgm_ops);
CREATE INDEX events_type_idx ON events (event_type_id);

-- An Event may involve several Actors. origin_actor_id records which Actor
-- the link was originally made to; it only differs from actor_id after an
-- Actor merge, and Helper Actor-scope grants are evaluated against it so that
-- merging Actors never silently widens or narrows a Helper's access.
CREATE TABLE event_actors (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id),
  origin_actor_id uuid NOT NULL REFERENCES actors(id),
  role text CHECK (role IS NULL OR length(role) <= 60),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, origin_actor_id)
);
CREATE INDEX event_actors_actor_idx ON event_actors (actor_id);
CREATE INDEX event_actors_origin_idx ON event_actors (origin_actor_id);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'monitoring', 'resolved', 'closed')),
  opened_on date NOT NULL DEFAULT current_date,
  closed_on date,
  impact_summary text,
  outcome_notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  purge_after timestamptz,
  search_vector tsvector,
  CHECK (closed_on IS NULL OR closed_on >= opened_on)
);
CREATE INDEX incidents_owner_idx ON incidents (owner_id, opened_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX incidents_search_idx ON incidents USING gin (search_vector);
CREATE INDEX incidents_title_trgm_idx ON incidents USING gin (title gin_trgm_ops);

CREATE TABLE incident_events (
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, event_id)
);
CREATE INDEX incident_events_event_idx ON incident_events (event_id);

CREATE TABLE event_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_a_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_b_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_a_id < event_b_id),
  UNIQUE (event_a_id, event_b_id)
);
CREATE INDEX event_relations_b_idx ON event_relations (event_b_id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  page_count integer,
  width integer,
  height integer,
  thumbnail_key text,
  preview_key text,
  derivative_status text NOT NULL DEFAULT 'pending'
    CHECK (derivative_status IN ('pending', 'processing', 'done', 'failed', 'not_applicable')),
  derivative_error text,
  ocr_status text NOT NULL DEFAULT 'pending'
    CHECK (ocr_status IN ('pending', 'processing', 'done', 'failed', 'not_applicable', 'disabled')),
  ocr_text text,
  ocr_corrected_text text,
  ocr_corrected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ocr_corrected_at timestamptz,
  ocr_engine text,
  ocr_processed_at timestamptz,
  ocr_error text,
  suggestions jsonb,
  integrity_checked_at timestamptz,
  integrity_ok boolean,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  purge_after timestamptz,
  search_vector tsvector,
  CHECK ((event_id IS NOT NULL)::int + (incident_id IS NOT NULL)::int = 1)
);
CREATE INDEX attachments_event_idx ON attachments (event_id) WHERE deleted_at IS NULL;
CREATE INDEX attachments_incident_idx ON attachments (incident_id) WHERE deleted_at IS NULL;
CREATE INDEX attachments_owner_idx ON attachments (owner_id);
CREATE INDEX attachments_search_idx ON attachments USING gin (search_vector);
CREATE INDEX attachments_sha_idx ON attachments (sha256);

-- ---------------------------------------------------------------------------
-- Integrity: revisions and external timestamps
-- ---------------------------------------------------------------------------

CREATE TABLE event_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  change_kind text NOT NULL CHECK (change_kind IN ('create', 'update', 'delete', 'restore')),
  changed_fields text[] NOT NULL DEFAULT '{}',
  canonical text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  previous_sha256 text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_via text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, revision)
);

-- Revisions are append-only: once written they may never be modified.
CREATE FUNCTION or_forbid_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event_revisions rows are immutable';
END;
$$;
CREATE TRIGGER event_revisions_immutable BEFORE UPDATE ON event_revisions
  FOR EACH ROW EXECUTE FUNCTION or_forbid_revision_update();

CREATE TABLE timestamp_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('attachment', 'event_revision')),
  subject_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'pending', 'complete', 'failed')),
  proof bytea,
  calendars text[] NOT NULL DEFAULT '{}',
  submitted_at timestamptz,
  upgraded_at timestamptz,
  last_checked_at timestamptz,
  attested_height integer,
  attested_time timestamptz,
  verified_at timestamptz,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, provider)
);
CREATE INDEX timestamp_proofs_status_idx ON timestamp_proofs (status);

-- ---------------------------------------------------------------------------
-- Helpers and access grants
-- ---------------------------------------------------------------------------

CREATE TABLE helper_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  helper_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  invited_email text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'ended')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ended_at timestamptz,
  CHECK (helper_user_id IS NULL OR helper_user_id <> owner_id)
);
CREATE INDEX helper_relationships_owner_idx ON helper_relationships (owner_id);
CREATE INDEX helper_relationships_helper_idx ON helper_relationships (helper_user_id);
CREATE UNIQUE INDEX helper_relationships_active_pair_idx
  ON helper_relationships (owner_id, helper_user_id) WHERE status = 'active';

CREATE TABLE access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL REFERENCES helper_relationships(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('all', 'actors', 'incidents')),
  date_from date,
  date_to date,
  can_add boolean NOT NULL DEFAULT false,
  can_export boolean NOT NULL DEFAULT false,
  co_actor_visibility text NOT NULL DEFAULT 'redacted' CHECK (co_actor_visibility IN ('redacted', 'name')),
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (date_to IS NULL OR date_from IS NULL OR date_to >= date_from)
);
CREATE INDEX access_grants_relationship_idx ON access_grants (relationship_id);

CREATE TABLE grant_actors (
  grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  PRIMARY KEY (grant_id, actor_id)
);

CREATE TABLE grant_incidents (
  grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  PRIMARY KEY (grant_id, incident_id)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship_id uuid NOT NULL REFERENCES helper_relationships(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  email text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit log (separate from the personal Event timeline)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_entries (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  outcome text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure')),
  target_type text,
  target_id text,
  via text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'mcp', 'system', 'cli')),
  oauth_client_id text,
  ip text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_entries_owner_idx ON audit_entries (owner_id, occurred_at DESC);
CREATE INDEX audit_entries_actor_idx ON audit_entries (actor_user_id, occurred_at DESC);
CREATE INDEX audit_entries_action_idx ON audit_entries (action);

-- ---------------------------------------------------------------------------
-- OAuth / MCP (storage for oidc-provider models plus OpenRampart grant info)
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_payloads (
  id text NOT NULL,
  model text NOT NULL,
  payload jsonb NOT NULL,
  grant_id text,
  user_code text,
  uid text,
  expires_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (model, id)
);
CREATE INDEX oauth_payloads_grant_idx ON oauth_payloads (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX oauth_payloads_uid_idx ON oauth_payloads (uid) WHERE uid IS NOT NULL;
CREATE INDEX oauth_payloads_expires_idx ON oauth_payloads (expires_at);

CREATE TABLE oauth_connections (
  grant_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  client_name text,
  client_uri text,
  redirect_host text,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX oauth_connections_user_idx ON oauth_connections (user_id);

-- ---------------------------------------------------------------------------
-- Full-text search maintenance
-- ---------------------------------------------------------------------------

CREATE FUNCTION or_actors_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.aliases, ' '), '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.account_reference, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C');
  RETURN NEW;
END;
$$;
CREATE TRIGGER actors_search_trg BEFORE INSERT OR UPDATE ON actors
  FOR EACH ROW EXECUTE FUNCTION or_actors_search_update();

CREATE FUNCTION or_events_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  type_label text;
BEGIN
  SELECT label INTO type_label FROM event_types WHERE id = NEW.event_type_id;
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.reference, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(type_label, '')), 'B') ||
    setweight(to_tsvector('english', to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'FMMonth YYYY')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.risk_note, '')), 'D');
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_search_trg BEFORE INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION or_events_search_update();

CREATE FUNCTION or_incidents_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.impact_summary, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.outcome_notes, '')), 'C');
  RETURN NEW;
END;
$$;
CREATE TRIGGER incidents_search_trg BEFORE INSERT OR UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION or_incidents_search_update();

CREATE FUNCTION or_attachments_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.original_filename, ''), '[._-]+', ' ', 'g')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(NEW.ocr_corrected_text, NEW.ocr_text, ''), 900000)), 'C');
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachments_search_trg BEFORE INSERT OR UPDATE OF original_filename, ocr_text, ocr_corrected_text ON attachments
  FOR EACH ROW EXECUTE FUNCTION or_attachments_search_update();

-- Aggregate used at query time to combine the search vectors of the Actors on
-- an Event that are visible to the current viewer (see src/server/domain/search.ts).
CREATE AGGREGATE or_tsvector_agg(tsvector) (
  SFUNC = tsvector_concat,
  STYPE = tsvector,
  INITCOND = ''
);
