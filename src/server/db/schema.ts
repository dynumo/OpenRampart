/**
 * Drizzle table definitions. These mirror the hand-written SQL migrations in
 * /migrations, which remain the source of truth for the database schema
 * (including triggers and search indexes). `tests/integration/schema.test.ts`
 * checks that every column declared here exists in the migrated database.
 */
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull(),
  email: text('email'),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  timezone: text('timezone').notNull().default('Europe/London'),
  totpSecretEnc: text('totp_secret_enc'),
  totpPendingSecretEnc: text('totp_pending_secret_enc'),
  totpEnabledAt: ts('totp_enabled_at'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  passwordChangedAt: ts('password_changed_at').notNull().defaultNow(),
  lastLoginAt: ts('last_login_at'),
  lastLoginIp: text('last_login_ip'),
  lastLoginUserAgent: text('last_login_user_agent'),
  previousLoginAt: ts('previous_login_at'),
  previousLoginIp: text('previous_login_ip'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lastFailedLoginAt: ts('last_failed_login_at'),
  disabledAt: ts('disabled_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const recoveryCodes = pgTable('recovery_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  codeHmac: text('code_hmac').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  usedAt: ts('used_at'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  csrfToken: text('csrf_token').notNull(),
  stage: text('stage').$type<'mfa' | 'totp_setup' | 'active'>().notNull(),
  mfaMethod: text('mfa_method').$type<'totp' | 'recovery_code' | null>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  revokedAt: ts('revoked_at'),
  revokedReason: text('revoked_reason'),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const rateLimits = pgTable('rate_limits', {
  key: varchar('key', { length: 255 }).primaryKey(),
  points: integer('points').notNull().default(0),
  expire: bigint('expire', { mode: 'number' }),
});

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const systemKeys = pgTable('system_keys', {
  id: text('id').primaryKey(),
  valueEnc: text('value_enc').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const eventTypes = pgTable('event_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull().default(''),
  defaultDirection: text('default_direction').$type<Direction | null>(),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(100),
  archivedAt: ts('archived_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type Direction = 'inbound' | 'outbound' | 'internal';
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';
export type IncidentStatus = 'open' | 'monitoring' | 'resolved' | 'closed';
export type ActorKind = 'organisation' | 'person' | 'other';

export const actors = pgTable('actors', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').$type<ActorKind>().notNull().default('organisation'),
  aliases: text('aliases').array().notNull().default([]),
  description: text('description').notNull().default(''),
  accountReference: text('account_reference'),
  website: text('website'),
  email: text('email'),
  phone: text('phone'),
  address: text('address'),
  archivedAt: ts('archived_at'),
  mergedIntoId: uuid('merged_into_id'),
  mergedAt: ts('merged_at'),
  deletedAt: ts('deleted_at'),
  deletedBy: uuid('deleted_by'),
  purgeAfter: ts('purge_after'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  searchVector: tsvector('search_vector'),
});

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  eventTypeId: uuid('event_type_id').notNull(),
  title: text('title').notNull().default(''),
  occurredAt: ts('occurred_at').notNull(),
  occurredPrecision: text('occurred_precision')
    .$type<'date' | 'datetime'>()
    .notNull()
    .default('datetime'),
  endedAt: ts('ended_at'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
  direction: text('direction').$type<Direction | null>(),
  description: text('description').notNull().default(''),
  tags: text('tags').array().notNull().default([]),
  riskLevel: text('risk_level').$type<RiskLevel>().notNull().default('none'),
  riskNote: text('risk_note'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  currency: text('currency'),
  reference: text('reference'),
  dueOn: date('due_on', { mode: 'string' }),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by'),
  createdVia: text('created_via')
    .$type<'web' | 'mcp' | 'audit' | 'import'>()
    .notNull()
    .default('web'),
  updatedBy: uuid('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
  deletedBy: uuid('deleted_by'),
  purgeAfter: ts('purge_after'),
  searchVector: tsvector('search_vector'),
});

export const eventActors = pgTable(
  'event_actors',
  {
    eventId: uuid('event_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    originActorId: uuid('origin_actor_id').notNull(),
    role: text('role'),
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.originActorId] })],
);

export const incidents = pgTable('incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').$type<IncidentStatus>().notNull().default('open'),
  openedOn: date('opened_on', { mode: 'string' }).notNull(),
  closedOn: date('closed_on', { mode: 'string' }),
  impactSummary: text('impact_summary'),
  outcomeNotes: text('outcome_notes'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
  deletedBy: uuid('deleted_by'),
  purgeAfter: ts('purge_after'),
  searchVector: tsvector('search_vector'),
});

export const incidentEvents = pgTable(
  'incident_events',
  {
    incidentId: uuid('incident_id').notNull(),
    eventId: uuid('event_id').notNull(),
    addedBy: uuid('added_by'),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.incidentId, t.eventId] })],
);

export const eventRelations = pgTable('event_relations', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  eventAId: uuid('event_a_id').notNull(),
  eventBId: uuid('event_b_id').notNull(),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type ProcessingStatus = 'pending' | 'processing' | 'done' | 'failed' | 'not_applicable';
export type OcrStatus = ProcessingStatus | 'disabled';

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  eventId: uuid('event_id'),
  incidentId: uuid('incident_id'),
  position: integer('position').notNull().default(0),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by'),
  uploadedAt: ts('uploaded_at').notNull().defaultNow(),
  pageCount: integer('page_count'),
  width: integer('width'),
  height: integer('height'),
  thumbnailKey: text('thumbnail_key'),
  previewKey: text('preview_key'),
  derivativeStatus: text('derivative_status')
    .$type<ProcessingStatus>()
    .notNull()
    .default('pending'),
  derivativeError: text('derivative_error'),
  ocrStatus: text('ocr_status').$type<OcrStatus>().notNull().default('pending'),
  ocrText: text('ocr_text'),
  ocrCorrectedText: text('ocr_corrected_text'),
  ocrCorrectedBy: uuid('ocr_corrected_by'),
  ocrCorrectedAt: ts('ocr_corrected_at'),
  ocrEngine: text('ocr_engine'),
  ocrProcessedAt: ts('ocr_processed_at'),
  ocrError: text('ocr_error'),
  suggestions: jsonb('suggestions').$type<DocumentSuggestions | null>(),
  integrityCheckedAt: ts('integrity_checked_at'),
  integrityOk: boolean('integrity_ok'),
  deletedAt: ts('deleted_at'),
  deletedBy: uuid('deleted_by'),
  purgeAfter: ts('purge_after'),
  searchVector: tsvector('search_vector'),
});

export interface DocumentSuggestions {
  dates: { value: string; text: string }[];
  amounts: { value: string; currency: string; text: string }[];
  references: { value: string; label: string }[];
  actors: { actorId: string | null; name: string; reason: string }[];
  title: string | null;
}

export const eventRevisions = pgTable('event_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull(),
  ownerId: uuid('owner_id').notNull(),
  revision: integer('revision').notNull(),
  changeKind: text('change_kind').$type<'create' | 'update' | 'delete' | 'restore'>().notNull(),
  changedFields: text('changed_fields').array().notNull().default([]),
  canonical: text('canonical').notNull(),
  sha256: text('sha256').notNull(),
  previousSha256: text('previous_sha256'),
  createdBy: uuid('created_by'),
  createdVia: text('created_via').notNull().default('web'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type TimestampStatus = 'queued' | 'pending' | 'complete' | 'failed';

export const timestampProofs = pgTable('timestamp_proofs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  subjectType: text('subject_type').$type<'attachment' | 'event_revision'>().notNull(),
  subjectId: uuid('subject_id').notNull(),
  digest: text('digest').notNull(),
  provider: text('provider').notNull(),
  status: text('status').$type<TimestampStatus>().notNull().default('queued'),
  proof: bytea('proof'),
  calendars: text('calendars').array().notNull().default([]),
  submittedAt: ts('submitted_at'),
  upgradedAt: ts('upgraded_at'),
  lastCheckedAt: ts('last_checked_at'),
  attestedHeight: integer('attested_height'),
  attestedTime: ts('attested_time'),
  verifiedAt: ts('verified_at'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const helperRelationships = pgTable('helper_relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  helperUserId: uuid('helper_user_id'),
  label: text('label').notNull(),
  invitedEmail: text('invited_email'),
  status: text('status').$type<'pending' | 'active' | 'ended'>().notNull().default('pending'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  acceptedAt: ts('accepted_at'),
  endedAt: ts('ended_at'),
});

export type GrantScope = 'all' | 'actors' | 'incidents';

export const accessGrants = pgTable('access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  relationshipId: uuid('relationship_id').notNull(),
  ownerId: uuid('owner_id').notNull(),
  scopeType: text('scope_type').$type<GrantScope>().notNull(),
  dateFrom: date('date_from', { mode: 'string' }),
  dateTo: date('date_to', { mode: 'string' }),
  canAdd: boolean('can_add').notNull().default(false),
  canExport: boolean('can_export').notNull().default(false),
  coActorVisibility: text('co_actor_visibility')
    .$type<'redacted' | 'name'>()
    .notNull()
    .default('redacted'),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
  revokedBy: uuid('revoked_by'),
});

export const grantActors = pgTable(
  'grant_actors',
  {
    grantId: uuid('grant_id').notNull(),
    actorId: uuid('actor_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.grantId, t.actorId] })],
);

export const grantIncidents = pgTable(
  'grant_incidents',
  {
    grantId: uuid('grant_id').notNull(),
    incidentId: uuid('incident_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.grantId, t.incidentId] })],
);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  relationshipId: uuid('relationship_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  email: text('email'),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  usedBy: uuid('used_by'),
  revokedAt: ts('revoked_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditEntries = pgTable('audit_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  ownerId: uuid('owner_id'),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  outcome: text('outcome').$type<'success' | 'failure'>().notNull().default('success'),
  targetType: text('target_type'),
  targetId: text('target_id'),
  via: text('via').$type<'web' | 'mcp' | 'system' | 'cli'>().notNull().default('web'),
  oauthClientId: text('oauth_client_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
});

export const oauthPayloads = pgTable(
  'oauth_payloads',
  {
    id: text('id').notNull(),
    model: text('model').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    grantId: text('grant_id'),
    userCode: text('user_code'),
    uid: text('uid'),
    expiresAt: ts('expires_at'),
    consumedAt: ts('consumed_at'),
  },
  (t) => [primaryKey({ columns: [t.model, t.id] })],
);

export const oauthConnections = pgTable('oauth_connections', {
  grantId: text('grant_id').primaryKey(),
  userId: uuid('user_id').notNull(),
  ownerId: uuid('owner_id').notNull(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name'),
  clientUri: text('client_uri'),
  redirectHost: text('redirect_host'),
  scopes: text('scopes').array().notNull().default([]),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});
