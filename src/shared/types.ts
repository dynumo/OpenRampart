/**
 * Data transfer types shared by the server API, the MCP server and the web UI.
 * Dates are ISO 8601 strings.
 */

export type Direction = 'inbound' | 'outbound' | 'internal';
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';
export type IncidentStatus = 'open' | 'monitoring' | 'resolved' | 'closed';
export type ActorKind = 'organisation' | 'person' | 'other';
export type Precision = 'date' | 'datetime';
export type ProcessingStatus = 'pending' | 'processing' | 'done' | 'failed' | 'not_applicable';
export type OcrStatus = ProcessingStatus | 'disabled';

export const RISK_LEVELS: RiskLevel[] = ['none', 'low', 'medium', 'high'];
export const INCIDENT_STATUSES: IncidentStatus[] = ['open', 'monitoring', 'resolved', 'closed'];
export const DIRECTIONS: Direction[] = ['inbound', 'outbound', 'internal'];

export interface EventTypeDTO {
  id: string;
  key: string;
  label: string;
  description: string;
  defaultDirection: Direction | null;
  isBuiltin: boolean;
  archived: boolean;
  sortOrder: number;
}

export interface UserRef {
  id: string;
  displayName: string;
}

/** An Actor as shown on an Event. Redacted links carry no identifying data. */
export type EventActorDTO =
  | { redacted: false; id: string; name: string; kind: ActorKind; role: string | null; fullAccess: boolean }
  | { redacted: true; role: null };

export interface IncidentRef {
  id: string;
  title: string;
  status: IncidentStatus;
}

export interface EventSummaryDTO {
  id: string;
  title: string;
  displayTitle: string;
  type: { id: string; key: string; label: string };
  occurredAt: string;
  occurredPrecision: Precision;
  endedAt: string | null;
  recordedAt: string;
  direction: Direction | null;
  summary: string;
  actors: EventActorDTO[];
  incidents: IncidentRef[];
  attachmentCount: number;
  riskLevel: RiskLevel;
  riskNote: string | null;
  tags: string[];
  amount: string | null;
  currency: string | null;
  reference: string | null;
  dueOn: string | null;
  createdBy: UserRef | null;
  createdVia: string;
}

export interface AttachmentDTO {
  id: string;
  eventId: string | null;
  incidentId: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedBy: UserRef | null;
  position: number;
  pageCount: number | null;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  hasPreview: boolean;
  derivativeStatus: ProcessingStatus;
  ocrStatus: OcrStatus;
  ocrProcessedAt: string | null;
  ocrEngine: string | null;
  ocrCorrected: boolean;
  integrity: { checkedAt: string | null; ok: boolean | null };
  timestamp: TimestampDTO | null;
  deletedAt: string | null;
}

export interface TimestampDTO {
  provider: string;
  status: 'queued' | 'pending' | 'complete' | 'failed';
  submittedAt: string | null;
  attestedTime: string | null;
  attestedHeight: number | null;
  verifiedAt: string | null;
  calendars: string[];
  error: string | null;
}

export interface RevisionDTO {
  revision: number;
  changeKind: 'create' | 'update' | 'delete' | 'restore';
  changedFields: string[];
  sha256: string;
  previousSha256: string | null;
  createdAt: string;
  createdBy: UserRef | null;
  createdVia: string;
  timestamp: TimestampDTO | null;
  /** Canonical JSON. Owner only. */
  canonical?: string;
}

export interface EventPermissions {
  canEdit: boolean;
  canDelete: boolean;
  canAddAttachment: boolean;
  canOrganise: boolean;
}

export interface EventDetailDTO extends EventSummaryDTO {
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: UserRef | null;
  deletedAt: string | null;
  attachments: AttachmentDTO[];
  related: RelatedEventDTO[];
  currentRevision: RevisionDTO | null;
  permissions: EventPermissions;
}

export interface RelatedEventDTO {
  relationId: string;
  id: string;
  displayTitle: string;
  occurredAt: string;
  occurredPrecision: Precision;
  typeLabel: string;
  note: string | null;
}

export interface ActorDTO {
  id: string;
  name: string;
  kind: ActorKind;
  fullAccess: boolean;
  aliases: string[];
  description: string;
  accountReference: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  archivedAt: string | null;
  mergedIntoId: string | null;
  createdAt: string;
  stats: {
    eventCount: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
    openIncidentCount: number;
  };
}

export interface IncidentDTO {
  id: string;
  title: string;
  description: string;
  status: IncidentStatus;
  openedOn: string;
  closedOn: string | null;
  impactSummary: string | null;
  outcomeNotes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  highestRisk: RiskLevel;
  attachments?: AttachmentDTO[];
  canEdit: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface GrantDTO {
  id: string;
  scopeType: 'all' | 'actors' | 'incidents';
  actors: { id: string; name: string }[];
  incidents: { id: string; title: string }[];
  dateFrom: string | null;
  dateTo: string | null;
  canAdd: boolean;
  canExport: boolean;
  coActorVisibility: 'redacted' | 'name';
  note: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface HelperDTO {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'ended';
  helper: { id: string; displayName: string; username: string } | null;
  invitedEmail: string | null;
  createdAt: string;
  acceptedAt: string | null;
  endedAt: string | null;
  grants: GrantDTO[];
  pendingInvitation: { id: string; expiresAt: string } | null;
}

export interface SearchResultDTO {
  events: (EventSummaryDTO & { snippet: string | null; matchedIn: string[] })[];
  actors: { id: string; name: string; kind: ActorKind; snippet: string | null }[];
  incidents: { id: string; title: string; status: IncidentStatus; snippet: string | null }[];
  documents: {
    attachmentId: string;
    eventId: string | null;
    incidentId: string | null;
    filename: string;
    snippet: string | null;
    parentTitle: string;
  }[];
  totals: { events: number; actors: number; incidents: number; documents: number };
}

/** Suggestions derived from a document's text. They are offered, never applied automatically. */
export interface DocumentSuggestionsDTO {
  dates: { value: string; text: string }[];
  amounts: { value: string; currency: string; text: string }[];
  references: { value: string; label: string }[];
  actors: { actorId: string | null; name: string; reason: string }[];
  title: string | null;
}
