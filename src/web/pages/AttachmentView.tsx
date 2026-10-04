import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AttachmentDTO, DocumentSuggestionsDTO } from '../../shared/types';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { Alert, ConfirmDialog, ErrorSummary, Loading, StatusLine } from '../components/ui';
import { api, apiUrl, attachmentUrl } from '../lib/api';
import { useRecord } from '../lib/auth';
import { bytes, formatDateTime } from '../lib/format';
import { usePageTitle } from '../lib/hooks';
import { TimestampStatus } from './EventDetail';

interface AttachmentText {
  status: string;
  engine: string | null;
  processedAt: string | null;
  text: string | null;
  originalText: string | null;
  corrected: boolean;
  correctedAt: string | null;
  error: string | null;
  suggestions: DocumentSuggestionsDTO | null;
}

function Suggestions({ s, eventId }: { s: DocumentSuggestionsDTO; eventId: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const apply = async (patch: Record<string, unknown>, label: string) => {
    if (!eventId) return;
    setError(null);
    try {
      await api(`/events/${eventId}`, { method: 'PATCH', body: patch });
      await qc.invalidateQueries();
      toast(`${label} applied to the Event`);
    } catch (err) {
      setError(err);
    }
  };
  const any = s.dates.length || s.amounts.length || s.references.length || s.actors.length || s.title;
  if (!any) return null;
  return (
    <section className="card" aria-labelledby="sugg-h">
      <h2 id="sugg-h">Found in the document</h2>
      <p className="small muted">These were read from the text automatically and may be wrong. Nothing is changed unless you choose to apply it.</p>
      <ErrorSummary error={error} />
      <ul className="plain-list">
        {s.title ? (
          <li>
            Title: “{s.title}”{' '}
            {eventId ? (
              <button type="button" className="btn btn-small" onClick={() => apply({ title: s.title }, 'Title')}>
                Use as title
              </button>
            ) : null}
          </li>
        ) : null}
        {s.dates.map((d) => (
          <li key={d.value}>
            Date: {new Date(`${d.value}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} <span className="muted">(“{d.text}”)</span>{' '}
            {eventId ? (
              <button type="button" className="btn btn-small" onClick={() => apply({ occurredAt: d.value }, 'Date')}>
                Use as Event date
              </button>
            ) : null}
          </li>
        ))}
        {s.amounts.map((a) => (
          <li key={a.currency + a.value}>
            Amount: {a.text}{' '}
            {eventId ? (
              <button type="button" className="btn btn-small" onClick={() => apply({ amount: a.value, currency: a.currency }, 'Amount')}>
                Use as amount
              </button>
            ) : null}
          </li>
        ))}
        {s.references.map((r) => (
          <li key={r.value}>
            {r.label}: <span className="mono">{r.value}</span>{' '}
            {eventId ? (
              <button type="button" className="btn btn-small" onClick={() => apply({ reference: r.value }, 'Reference')}>
                Use as reference
              </button>
            ) : null}
          </li>
        ))}
        {s.actors.map((a) => (
          <li key={a.actorId ?? a.name}>
            {a.actorId ? <Link to={`/actors/${a.actorId}`}>{a.name}</Link> : a.name} <span className="muted small">— {a.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AttachmentViewPage() {
  const { id } = useParams();
  const record = useRecord();
  const tz = record.data?.timezone;
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useQuery({
    queryKey: ['attachment', id],
    queryFn: () => api<AttachmentDTO>(`/attachments/${id}`),
    refetchInterval: (q) => (q.state.data && ['pending', 'processing'].includes(q.state.data.ocrStatus) ? 4000 : false),
  });
  const text = useQuery({ queryKey: ['attachment-text', id, meta.data?.ocrStatus], queryFn: () => api<AttachmentText>(`/attachments/${id}/text`), enabled: Boolean(meta.data) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [verify, setVerify] = useState<{ integrity: { ok: boolean; checkedAt: string }; timestamp: { status: string; detail?: string } } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  usePageTitle(meta.data?.originalFilename ?? 'Attachment');
  if (meta.error) return <ErrorSummary error={meta.error} />;
  if (!meta.data) return <Loading />;
  const a = meta.data;
  const isImage = /^image\/(jpeg|png|webp|gif|avif)$/.test(a.mimeType);
  const isPdf = a.mimeType === 'application/pdf';
  const isAudio = a.mimeType.startsWith('audio/');
  const isOwner = record.data?.role === 'owner';

  return (
    <>
      <p>
        {a.eventId ? <Link to={`/events/${a.eventId}`}>← Back to the Event</Link> : a.incidentId ? <Link to={`/incidents/${a.incidentId}`}>← Back to the Incident</Link> : null}
      </p>
      <PageHeader
        title={a.originalFilename}
        lede={`${a.mimeType} · ${bytes(a.sizeBytes)} · uploaded ${formatDateTime(a.uploadedAt, tz)}${a.uploadedBy ? ` by ${a.uploadedBy.displayName}` : ''}`}
        actions={
          <a className="btn" href={attachmentUrl(a.id, 'original', true)} download={a.originalFilename}>
            <Icon name="download" /> Download original
          </a>
        }
      />
      <div className="layout-sidebar">
        <div className="stack">
          <section aria-label="Document" className="viewer">
            {isPdf ? (
              <iframe src={attachmentUrl(a.id, 'original')} title={`PDF document: ${a.originalFilename}`} />
            ) : isImage ? (
              <img src={a.hasPreview ? attachmentUrl(a.id, 'preview') : attachmentUrl(a.id, 'original')} alt={`Image: ${a.originalFilename}. The recognised text is shown below.`} />
            ) : a.hasPreview ? (
              <img src={attachmentUrl(a.id, 'preview')} alt={`Preview of ${a.originalFilename}. The recognised text is shown below.`} />
            ) : isAudio ? (
              <audio controls src={attachmentUrl(a.id, 'original')}>
                Your browser cannot play this audio. Download the original instead.
              </audio>
            ) : (
              <p>This file type cannot be previewed in the browser. Download the original to open it.</p>
            )}
          </section>
          <section className="card" aria-labelledby="text-h">
            <h2 id="text-h">Text from this document</h2>
            {a.ocrStatus === 'pending' || a.ocrStatus === 'processing' ? (
              <p role="status">Reading the text… this usually takes under a minute.</p>
            ) : a.ocrStatus === 'failed' ? (
              <Alert kind="warning" title="The text could not be read">
                {text.data?.error ?? 'The original file is unaffected.'}
                {isOwner ? (
                  <p>
                    <button type="button" className="btn btn-small" onClick={async () => { await api(`/attachments/${a.id}/reprocess`, { method: 'POST' }); await qc.invalidateQueries(); }}>
                      Try again
                    </button>
                  </p>
                ) : null}
              </Alert>
            ) : a.ocrStatus === 'not_applicable' ? (
              <p className="muted">Text recognition does not apply to this type of file.</p>
            ) : a.ocrStatus === 'disabled' ? (
              <p className="muted">Text recognition is turned off on this server.</p>
            ) : text.data ? (
              <>
                <p className="small muted">
                  Read by {text.data.engine} on {formatDateTime(text.data.processedAt, tz)}.{text.data.corrected ? ` Corrected by hand on ${formatDateTime(text.data.correctedAt, tz)}.` : ''} Automatic recognition can make mistakes; the original file is the authoritative copy.
                </p>
                {editing ? (
                  <form
                    onSubmit={async (ev) => {
                      ev.preventDefault();
                      setError(null);
                      try {
                        await api(`/attachments/${a.id}/text`, { method: 'PUT', body: { text: draft } });
                        setEditing(false);
                        await qc.invalidateQueries({ queryKey: ['attachment-text', id] });
                        toast('Corrected text saved');
                      } catch (err) {
                        setError(err);
                      }
                    }}
                  >
                    <ErrorSummary error={error} />
                    <div className="field">
                      <label htmlFor="ocr-edit">Corrected text</label>
                      <span className="hint">Your correction is used for search. The original file and the automatically read text are both kept.</span>
                      <textarea id="ocr-edit" value={draft} rows={16} onChange={(ev) => setDraft(ev.target.value)} style={{ maxWidth: '100%' }} />
                    </div>
                    <div className="row">
                      <button type="submit" className="btn btn-primary">Save correction</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="ocr-text" tabIndex={0} role="region" aria-label="Recognised text">
                      {text.data.text || '(No text was found.)'}
                    </div>
                    <div className="row" style={{ marginTop: '0.75rem' }}>
                      <button type="button" className="btn btn-small" onClick={() => { setDraft(text.data!.text ?? ''); setEditing(true); }}>
                        Correct the text
                      </button>
                      {text.data.corrected ? (
                        <button type="button" className="btn btn-small btn-ghost" onClick={async () => { await api(`/attachments/${a.id}/text`, { method: 'PUT', body: { text: null } }); await qc.invalidateQueries({ queryKey: ['attachment-text', id] }); }}>
                          Revert to automatic text
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </>
            ) : (
              <Loading />
            )}
          </section>
          {text.data?.suggestions ? <Suggestions s={text.data.suggestions} eventId={a.eventId} /> : null}
        </div>
        <aside className="stack" aria-label="Integrity">
          <section className="card" aria-labelledby="int-h">
            <h2 id="int-h">Integrity</h2>
            <p>
              {a.integrity.ok === true ? (
                <StatusLine ok>Original unchanged (checked {formatDateTime(a.integrity.checkedAt, tz)})</StatusLine>
              ) : a.integrity.ok === false ? (
                <StatusLine>The stored file does not match its recorded fingerprint</StatusLine>
              ) : (
                <StatusLine warn>Not yet checked</StatusLine>
              )}
            </p>
            <p>
              <TimestampStatus ts={a.timestamp} />
            </p>
            <button
              type="button"
              className="btn btn-small"
              onClick={async () => {
                setVerify(null);
                setVerify(await api(`/attachments/${a.id}/verify`, { method: 'POST' }));
                await qc.invalidateQueries({ queryKey: ['attachment', id] });
              }}
            >
              <Icon name="shield" /> Verify now
            </button>
            {verify ? (
              <p role="status" className="small">
                {verify.integrity.ok ? 'Integrity verified: the original is unchanged.' : 'Integrity check failed.'}{' '}
                {verify.timestamp.status === 'complete' ? 'Timestamp verified.' : verify.timestamp.status === 'pending' ? 'Timestamp still pending.' : ''}
              </p>
            ) : null}
            <details className="small">
              <summary>Technical details</summary>
              <p>
                SHA-256 of the original:
                <br />
                <span className="mono">{a.sha256}</span>
              </p>
              {a.timestamp && a.timestamp.status !== 'queued' ? (
                <p>
                  <a href={apiUrl(`/attachments/${a.id}/timestamp.ots`)} download>
                    Download OpenTimestamps proof (.ots)
                  </a>
                </p>
              ) : null}
              <p className="muted">A timestamp shows that this exact file existed by the time given. It does not show that what the document says is true.</p>
            </details>
          </section>
          {isOwner && !a.deletedAt ? (
            <section className="card">
              <h2>Delete</h2>
              <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" /> Move to trash
              </button>
            </section>
          ) : null}
        </aside>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Move this attachment to the trash?"
        body={<p>“{a.originalFilename}” will be removed from the Event. You can restore it from the trash until it is permanently deleted.</p>}
        confirmLabel="Move to trash"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api(`/attachments/${a.id}`, { method: 'DELETE' });
          await qc.invalidateQueries();
          window.history.back();
        }}
      />
    </>
  );
}
