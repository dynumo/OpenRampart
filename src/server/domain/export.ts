import { PassThrough, type Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import yazl from 'yazl';
import { formatOccurrence } from '../../shared/dates.js';
import { ForbiddenError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { sanitiseFilename } from '../storage/fileTypes.js';
import { getObjectStream } from '../storage/s3.js';
import {
  actorFullAccess,
  actorVisible,
  attachmentVisible,
  eventVisible,
  incidentVisible,
  restrictContext,
} from './access.js';
import { auditCtx } from './audit.js';
import {
  canExportAnything,
  hasScope,
  isOwner,
  requireScopes,
  type AccessContext,
} from './context.js';
import { summariesFor, type EventRow } from './events.js';
import { rows } from './sqlutil.js';

/**
 * Complete export of the record (or, for a Helper, of what their export-capable
 * grants cover) as a ZIP of ordinary files: JSON data, the original
 * attachments byte-for-byte, OCR text, hashes and timestamp proofs, with a
 * README explaining everything. Format documented in docs/export-format.md.
 */
export const EXPORT_SCHEMA = 'openrampart.export.v1';

function zipPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/[\\/]+/g, '_').replace(/^\.+/, '_')).join('/');
}

export async function assertCanExport(ctx: AccessContext): Promise<AccessContext> {
  requireScopes(ctx, 'export:read');
  if (!canExportAnything(ctx))
    throw new ForbiddenError('Your access to this record does not include exporting');
  return restrictContext(ctx, 'export');
}

export interface ExportData {
  manifest: Record<string, unknown>;
  events: unknown[];
  actors: unknown[];
  incidents: unknown[];
  relations: unknown[];
  revisions: unknown[];
  attachments: {
    id: string;
    eventId: string | null;
    incidentId: string | null;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    uploadedAt: string;
    storageKey: string;
    ocrText: string | null;
    ocrCorrectedText: string | null;
    ocrEngine: string | null;
    path: string;
  }[];
  timestamps: {
    subjectType: string;
    subjectId: string;
    digest: string;
    status: string;
    proof: Buffer | null;
    attestedTime: string | null;
    attestedHeight: number | null;
  }[];
}

/** Gather everything visible to an export-capable context. */
export async function collectExport(
  ctx: AccessContext,
  opts: { includeContents?: boolean } = {},
): Promise<ExportData> {
  const ex = await assertCanExport(ctx);
  const includeContents = opts.includeContents ?? hasScope(ctx, 'attachments:read');
  const eventRows = await rows<EventRow>(sql`
    SELECT e.id, e.owner_id, e.title, e.description, e.occurred_at, e.occurred_precision, e.ended_at, e.recorded_at,
      e.direction, e.tags, e.risk_level, e.risk_note, e.amount::text AS amount, e.currency, e.reference,
      e.due_on::text AS due_on, e.revision, e.created_by, cu.display_name AS created_by_name, e.updated_by,
      uu.display_name AS updated_by_name, e.created_via, e.created_at, e.updated_at, e.deleted_at,
      t.id AS type_id, t.key AS type_key, t.label AS type_label
    FROM events e JOIN event_types t ON t.id = e.event_type_id
    LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users uu ON uu.id = e.updated_by
    WHERE ${eventVisible(ex, 'e')} ORDER BY e.occurred_at, e.id`);
  const summaries = await summariesFor(ex, eventRows);
  const byId = new Map(eventRows.map((r) => [r.id, r]));
  const events = summaries.map((s) => {
    const r = byId.get(s.id)!;
    return {
      id: s.id,
      title: s.title,
      displayTitle: s.displayTitle,
      type: s.type.key,
      typeLabel: s.type.label,
      occurredAt: s.occurredAt,
      occurredPrecision: s.occurredPrecision,
      endedAt: s.endedAt,
      recordedAt: s.recordedAt,
      direction: s.direction,
      description: r.description,
      tags: s.tags,
      riskLevel: s.riskLevel,
      riskNote: s.riskNote,
      amount: s.amount,
      currency: s.currency,
      reference: s.reference,
      dueOn: s.dueOn,
      actors: s.actors.map((a) =>
        a.redacted ? { redacted: true } : { id: a.id, name: a.name, role: a.role },
      ),
      incidentIds: s.incidents.map((i) => i.id),
      revision: r.revision,
      createdAt: r.created_at.toISOString(),
      createdBy: s.createdBy,
      createdVia: s.createdVia,
      updatedAt: r.updated_at.toISOString(),
    };
  });

  const actors = await rows<Record<string, unknown>>(sql`
    SELECT a.id, a.name, a.kind,
      CASE WHEN ${actorFullAccess(ex, 'a')} THEN a.aliases ELSE '{}'::text[] END AS aliases,
      CASE WHEN ${actorFullAccess(ex, 'a')} THEN a.description ELSE '' END AS description,
      CASE WHEN ${actorFullAccess(ex, 'a')} THEN a.account_reference END AS "accountReference",
      CASE WHEN ${actorFullAccess(ex, 'a')} THEN a.website END AS website,
      CASE WHEN ${actorFullAccess(ex, 'a')} THEN a.email END AS email,
      CASE WHEN ${actorFullAccess(ex, 'a')} THEN a.phone END AS phone,
      CASE WHEN ${actorFullAccess(ex, 'a')} THEN a.address END AS address,
      a.archived_at AS "archivedAt", a.merged_into_id AS "mergedIntoId", a.created_at AS "createdAt"
    FROM actors a WHERE ${actorVisible(ex, 'a')} ORDER BY lower(a.name)`);

  const incidents = await rows<Record<string, unknown>>(sql`
    SELECT i.id, i.title, i.description, i.status, i.opened_on::text AS "openedOn", i.closed_on::text AS "closedOn",
      i.impact_summary AS "impactSummary", i.outcome_notes AS "outcomeNotes", i.created_at AS "createdAt",
      coalesce((SELECT array_agg(ie.event_id ORDER BY e.occurred_at) FROM incident_events ie JOIN events e ON e.id = ie.event_id
                WHERE ie.incident_id = i.id AND ${eventVisible(ex, 'e')}), '{}') AS "eventIds"
    FROM incidents i WHERE ${incidentVisible(ex, 'i')} ORDER BY i.opened_on`);

  const relations = await rows<Record<string, unknown>>(sql`
    SELECT r.id, r.event_a_id AS "eventA", r.event_b_id AS "eventB", r.note, r.created_at AS "createdAt"
    FROM event_relations r
    WHERE r.owner_id = ${ex.ownerId}
      AND EXISTS (SELECT 1 FROM events e WHERE e.id = r.event_a_id AND ${eventVisible(ex, 'e')})
      AND EXISTS (SELECT 1 FROM events e WHERE e.id = r.event_b_id AND ${eventVisible(ex, 'e')})`);

  // Revision snapshots may contain Actor names a Helper cannot see, so the
  // full revision history is included for owners only.
  const revisions = isOwner(ex)
    ? await rows<Record<string, unknown>>(sql`
        SELECT r.id, r.event_id AS "eventId", r.revision, r.change_kind AS "changeKind", r.changed_fields AS "changedFields",
          r.canonical, r.sha256, r.previous_sha256 AS "previousSha256", r.created_at AS "createdAt", r.created_by AS "createdBy",
          r.created_via AS "createdVia"
        FROM event_revisions r JOIN events e ON e.id = r.event_id
        WHERE r.owner_id = ${ex.ownerId} AND ${eventVisible(ex, 'e')}
        ORDER BY r.event_id, r.revision`)
    : [];

  const atts = hasScope(ctx, 'attachments:metadata')
    ? await rows<{
        id: string;
        event_id: string | null;
        incident_id: string | null;
        original_filename: string;
        mime_type: string;
        size_bytes: string;
        sha256: string;
        uploaded_at: Date;
        storage_key: string;
        ocr_text: string | null;
        ocr_corrected_text: string | null;
        ocr_engine: string | null;
        position: number;
        occurred_at: Date | null;
      }>(sql`
        SELECT att.id, att.event_id, att.incident_id, att.original_filename, att.mime_type, att.size_bytes, att.sha256,
          att.uploaded_at, att.storage_key, att.ocr_text, att.ocr_corrected_text, att.ocr_engine, att.position, ev.occurred_at
        FROM attachments att LEFT JOIN events ev ON ev.id = att.event_id
        WHERE ${attachmentVisible(ex, 'att')}
        ORDER BY att.event_id, att.incident_id, att.position`)
    : [];
  const attachments = atts.map((a) => {
    const folder = a.event_id
      ? zipPath(
          'attachments',
          'events',
          `${a.occurred_at?.toISOString().slice(0, 10) ?? 'undated'}_${a.event_id}`,
        )
      : zipPath('attachments', 'incidents', a.incident_id!);
    return {
      id: a.id,
      eventId: a.event_id,
      incidentId: a.incident_id,
      originalFilename: a.original_filename,
      mimeType: a.mime_type,
      sizeBytes: Number(a.size_bytes),
      sha256: a.sha256,
      uploadedAt: a.uploaded_at.toISOString(),
      storageKey: a.storage_key,
      ocrText: includeContents ? a.ocr_text : null,
      ocrCorrectedText: includeContents ? a.ocr_corrected_text : null,
      ocrEngine: a.ocr_engine,
      path: `${folder}/${String(a.position + 1).padStart(2, '0')}_${a.id.slice(0, 8)}_${sanitiseFilename(a.original_filename)}`,
    };
  });

  const timestamps = await rows<{
    subject_type: string;
    subject_id: string;
    digest: string;
    status: string;
    proof: Buffer | null;
    attested_time: Date | null;
    attested_height: number | null;
  }>(sql`
    SELECT tp.subject_type, tp.subject_id, tp.digest, tp.status, tp.proof, tp.attested_time, tp.attested_height
    FROM timestamp_proofs tp
    WHERE tp.owner_id = ${ex.ownerId} AND (
      (tp.subject_type = 'attachment' AND EXISTS (SELECT 1 FROM attachments att WHERE att.id = tp.subject_id AND ${attachmentVisible(ex, 'att')}) AND ${hasScope(ctx, 'attachments:metadata') ? sql`TRUE` : sql`FALSE`})
      OR (tp.subject_type = 'event_revision' AND ${isOwner(ex) ? sql`TRUE` : sql`FALSE`} AND EXISTS (
        SELECT 1 FROM event_revisions r JOIN events e ON e.id = r.event_id WHERE r.id = tp.subject_id AND ${eventVisible(ex, 'e')}))
    )`);

  const [owner] = await rows<{ display_name: string }>(
    sql`SELECT display_name FROM users WHERE id = ${ex.ownerId}::uuid`,
  );
  return {
    manifest: {
      schema: EXPORT_SCHEMA,
      exportedAt: new Date().toISOString(),
      recordOwner: owner?.display_name ?? null,
      recordOwnerId: ex.ownerId,
      exportedBy: ex.userId,
      scope: isOwner(ex) ? 'complete' : 'helper',
      timezone: ex.ownerTimezone,
      counts: {
        events: events.length,
        actors: actors.length,
        incidents: incidents.length,
        relations: relations.length,
        revisions: revisions.length,
        attachments: attachments.length,
        timestampProofs: timestamps.length,
      },
      attachmentContentsIncluded: includeContents,
      notes: isOwner(ex)
        ? []
        : [
            'This export contains only the parts of the record shared with you. Actors outside your access are shown as "redacted".',
          ],
    },
    events,
    actors,
    incidents,
    relations,
    revisions,
    attachments,
    timestamps: timestamps.map((t) => ({
      subjectType: t.subject_type,
      subjectId: t.subject_id,
      digest: t.digest,
      status: t.status,
      proof: t.proof,
      attestedTime: t.attested_time?.toISOString() ?? null,
      attestedHeight: t.attested_height,
    })),
  };
}

function readme(data: ExportData): string {
  const m = data.manifest as {
    exportedAt: string;
    recordOwner: string;
    scope: string;
    counts: Record<string, number>;
    timezone: string;
    notes: string[];
  };
  return `# OpenRampart export

Exported: ${m.exportedAt}
Record: ${m.recordOwner ?? 'unknown'}${m.scope === 'helper' ? ' (the part shared with you)' : ''}
Time zone used for dates: ${m.timezone}

This archive is a complete, self-describing copy of the record in ordinary
formats. You do not need OpenRampart to read it.

## Contents

| Path | What it is |
| --- | --- |
| \`manifest.json\` | Export metadata and counts |
| \`events.json\` | ${m.counts.events} Events, oldest first |
| \`actors.json\` | ${m.counts.actors} Actors (organisations and people) |
| \`incidents.json\` | ${m.counts.incidents} Incidents and the Events they group |
| \`relations.json\` | ${m.counts.relations} links between related Events |
| \`revisions.json\` | ${m.counts.revisions} Event revisions with canonical JSON and SHA-256 hashes |
| \`attachments.json\` | ${m.counts.attachments} attachments: names, types, sizes, SHA-256 hashes, OCR text |
| \`attachments/\` | The original files exactly as uploaded, plus \`.ocr.txt\` text files |
| \`timestamps/\` | OpenTimestamps proofs (\`.ots\`) for attachment and revision hashes |
| \`timeline.md\` | A readable timeline of all Events |

## Checking integrity

Each original file's SHA-256 is listed in \`attachments.json\`. To check one:

    sha256sum attachments/events/<folder>/<file>

Each revision's \`canonical\` text is RFC 8785 canonical JSON; its SHA-256 is
the revision hash. \`previousSha256\` links each revision to the one before.

A \`.ots\` file can be checked with the OpenTimestamps client
(\`ots verify -d <sha256> file.ots\`). A verified timestamp shows that the hash
existed no later than the given time. It does not show that the content of a
document is true.

${m.notes.map((n) => `> ${n}`).join('\n')}

Format reference: https://github.com/dynumo/OpenRampart/blob/main/docs/export-format.md
`;
}

function timeline(data: ExportData, timezone: string): string {
  const lines = ['# Timeline', ''];
  for (const e of data.events as {
    occurredAt: string;
    occurredPrecision: 'date' | 'datetime';
    displayTitle: string;
    typeLabel: string;
    actors: { name?: string; redacted?: boolean }[];
    description: string;
    riskLevel: string;
    id: string;
  }[]) {
    const when = formatOccurrence(e.occurredAt, e.occurredPrecision, timezone);
    const who = e.actors.map((a) => (a.redacted ? '(redacted)' : a.name)).join(', ');
    lines.push(
      `## ${when} — ${e.displayTitle}`,
      '',
      `*${e.typeLabel}*${who ? ` · ${who}` : ''}${e.riskLevel !== 'none' ? ` · Risk: ${e.riskLevel}` : ''}`,
      '',
    );
    if (e.description) lines.push(e.description, '');
    lines.push(`<small>Event ${e.id}</small>`, '');
  }
  return lines.join('\n');
}

/** Stream the export as a ZIP archive. */
export async function exportZip(
  ctx: AccessContext,
): Promise<{ stream: Readable; filename: string }> {
  const data = await collectExport(ctx);
  const zip = new yazl.ZipFile();
  const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8');
  zip.addBuffer(Buffer.from(readme(data)), 'README.md');
  zip.addBuffer(json(data.manifest), 'manifest.json');
  zip.addBuffer(json(data.events), 'events.json');
  zip.addBuffer(json(data.actors), 'actors.json');
  zip.addBuffer(json(data.incidents), 'incidents.json');
  zip.addBuffer(json(data.relations), 'relations.json');
  zip.addBuffer(json(data.revisions), 'revisions.json');
  zip.addBuffer(json(data.attachments.map(({ storageKey: _k, ...a }) => a)), 'attachments.json');
  zip.addBuffer(Buffer.from(timeline(data, ctx.ownerTimezone)), 'timeline.md');
  for (const t of data.timestamps) {
    if (t.proof)
      zip.addBuffer(
        Buffer.from(t.proof),
        zipPath('timestamps', `${t.subjectType}_${t.subjectId}.ots`),
      );
  }
  const includeFiles = hasScope(ctx, 'attachments:read');
  for (const a of data.attachments) {
    const text = a.ocrCorrectedText ?? a.ocrText;
    if (text) zip.addBuffer(Buffer.from(text, 'utf8'), `${a.path}.ocr.txt`);
  }
  await auditCtx(ctx, 'export.created', {
    type: 'export',
    metadata: { counts: data.manifest.counts, files: includeFiles },
  });

  const out = new PassThrough();
  zip.outputStream.pipe(out);
  // Add original files sequentially so only one object is downloaded at a time.
  void (async () => {
    try {
      if (includeFiles) {
        for (const a of data.attachments) {
          const { body } = await getObjectStream(a.storageKey);
          await new Promise<void>((resolve, reject) => {
            body.once('end', resolve);
            body.once('error', reject);
            zip.addReadStream(body, a.path, { size: a.sizeBytes });
          });
        }
      }
      zip.end();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'export failed while adding files');
      out.destroy(err as Error);
    }
  })();
  const date = new Date().toISOString().slice(0, 10);
  return { stream: out, filename: `openrampart-export-${date}.zip` };
}
