import { sql } from 'drizzle-orm';
import type { AttachmentDTO, TimestampDTO } from '../../shared/types.js';
import { attachmentVisible } from './access.js';
import type { AccessContext } from './context.js';
import { iso, rows } from './sqlutil.js';

/** Read-side queries for attachments shared by Event and Incident views. */

export interface AttachmentRow {
  id: string;
  owner_id: string;
  event_id: string | null;
  incident_id: string | null;
  position: number;
  original_filename: string;
  mime_type: string;
  size_bytes: string | number;
  storage_key: string;
  sha256: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  uploaded_at: Date;
  page_count: number | null;
  width: number | null;
  height: number | null;
  thumbnail_key: string | null;
  preview_key: string | null;
  derivative_status: AttachmentDTO['derivativeStatus'];
  ocr_status: AttachmentDTO['ocrStatus'];
  ocr_processed_at: Date | null;
  ocr_engine: string | null;
  ocr_corrected_at: Date | null;
  integrity_checked_at: Date | null;
  integrity_ok: boolean | null;
  deleted_at: Date | null;
  ts_provider: string | null;
  ts_status: TimestampDTO['status'] | null;
  ts_submitted_at: Date | null;
  ts_attested_time: Date | null;
  ts_attested_height: number | null;
  ts_verified_at: Date | null;
  ts_calendars: string[] | null;
  ts_error: string | null;
}

export function timestampFromRow(r: {
  ts_provider: string | null;
  ts_status: TimestampDTO['status'] | null;
  ts_submitted_at: Date | null;
  ts_attested_time: Date | null;
  ts_attested_height: number | null;
  ts_verified_at: Date | null;
  ts_calendars: string[] | null;
  ts_error: string | null;
}): TimestampDTO | null {
  if (!r.ts_provider || !r.ts_status) return null;
  return {
    provider: r.ts_provider,
    status: r.ts_status,
    submittedAt: iso(r.ts_submitted_at),
    attestedTime: iso(r.ts_attested_time),
    attestedHeight: r.ts_attested_height,
    verifiedAt: iso(r.ts_verified_at),
    calendars: r.ts_calendars ?? [],
    error: r.ts_error,
  };
}

export function toAttachmentDTO(r: AttachmentRow): AttachmentDTO {
  return {
    id: r.id,
    eventId: r.event_id,
    incidentId: r.incident_id,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    sha256: r.sha256,
    uploadedAt: iso(r.uploaded_at)!,
    uploadedBy: r.uploaded_by ? { id: r.uploaded_by, displayName: r.uploaded_by_name ?? 'Unknown' } : null,
    position: r.position,
    pageCount: r.page_count,
    width: r.width,
    height: r.height,
    hasThumbnail: Boolean(r.thumbnail_key),
    hasPreview: Boolean(r.preview_key),
    derivativeStatus: r.derivative_status,
    ocrStatus: r.ocr_status,
    ocrProcessedAt: iso(r.ocr_processed_at),
    ocrEngine: r.ocr_engine,
    ocrCorrected: r.ocr_corrected_at !== null,
    integrity: { checkedAt: iso(r.integrity_checked_at), ok: r.integrity_ok },
    timestamp: timestampFromRow(r),
    deletedAt: iso(r.deleted_at),
  };
}

const SELECT = sql`
  SELECT att.id, att.owner_id, att.event_id, att.incident_id, att.position, att.original_filename,
         att.mime_type, att.size_bytes, att.storage_key, att.sha256, att.uploaded_by, u.display_name AS uploaded_by_name,
         att.uploaded_at, att.page_count, att.width, att.height, att.thumbnail_key, att.preview_key,
         att.derivative_status, att.ocr_status, att.ocr_processed_at, att.ocr_engine, att.ocr_corrected_at,
         att.integrity_checked_at, att.integrity_ok, att.deleted_at,
         tp.provider AS ts_provider, tp.status AS ts_status, tp.submitted_at AS ts_submitted_at,
         tp.attested_time AS ts_attested_time, tp.attested_height AS ts_attested_height,
         tp.verified_at AS ts_verified_at, tp.calendars AS ts_calendars, tp.error AS ts_error
  FROM attachments att
  LEFT JOIN users u ON u.id = att.uploaded_by
  LEFT JOIN timestamp_proofs tp ON tp.subject_type = 'attachment' AND tp.subject_id = att.id`;

export async function attachmentsForEvents(ctx: AccessContext, eventIds: string[]): Promise<AttachmentRow[]> {
  if (!eventIds.length) return [];
  return rows<AttachmentRow>(sql`${SELECT}
    WHERE att.event_id IN (${sql.join(eventIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND ${attachmentVisible(ctx, 'att')}
    ORDER BY att.position, att.uploaded_at`);
}

export async function attachmentsForIncident(ctx: AccessContext, incidentId: string): Promise<AttachmentRow[]> {
  return rows<AttachmentRow>(sql`${SELECT}
    WHERE att.incident_id = ${incidentId}::uuid AND ${attachmentVisible(ctx, 'att')}
    ORDER BY att.position, att.uploaded_at`);
}

export async function attachmentRow(
  ctx: AccessContext,
  attachmentId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<AttachmentRow | undefined> {
  const [row] = await rows<AttachmentRow>(sql`${SELECT}
    WHERE att.id = ${attachmentId}::uuid AND ${attachmentVisible(ctx, 'att', opts)}`);
  return row;
}
