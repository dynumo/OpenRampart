import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { AttachmentDTO, EventDetailDTO, IncidentDTO, RevisionDTO, TimestampDTO } from '../../shared/types';
import { RiskBadge } from '../components/EventList';
import { Icon, TYPE_ICONS } from '../components/Icon';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { Alert, ConfirmDialog, Dialog, ErrorSummary, Loading, SelectField, StatusLine, TextField } from '../components/ui';
import { api, apiUrl, attachmentUrl, uploadFile } from '../lib/api';
import { useRecord } from '../lib/auth';
import { bytes, DIRECTION_LABEL, formatDateTime, formatWhen, money } from '../lib/format';
import { usePageTitle } from '../lib/hooks';

export function TimestampStatus({ ts }: { ts: TimestampDTO | null }) {
  if (!ts) return <span className="muted">Not timestamped</span>;
  if (ts.status === 'complete')
    return (
      <StatusLine ok>
        Timestamp verified: existed by {formatDateTime(ts.attestedTime)}
      </StatusLine>
    );
  if (ts.status === 'failed') return <StatusLine>Timestamp could not be completed</StatusLine>;
  return <StatusLine warn>Timestamp pending (usually completes within a few hours)</StatusLine>;
}

export function AttachmentGallery({ items, eventTitle }: { items: AttachmentDTO[]; eventTitle: string }) {
  return (
    <ul className="gallery">
      {items.map((a, i) => (
        <li key={a.id}>
          <Link className="thumb" to={`/attachments/${a.id}`}>
            {a.hasThumbnail ? (
              <img className="thumb-img" src={attachmentUrl(a.id, 'thumbnail')} alt="" loading="lazy" />
            ) : (
              <span className="thumb-icon">
                <Icon name={a.mimeType.startsWith('image/') ? 'image' : 'file'} />
              </span>
            )}
            <span className="thumb-caption">
              <span className="visually-hidden">
                {eventTitle}, attachment {i + 1}:{' '}
              </span>
              {a.originalFilename}
              <br />
              <span className="muted small">
                {bytes(a.sizeBytes)}
                {a.pageCount ? ` · ${a.pageCount} page${a.pageCount > 1 ? 's' : ''}` : ''}
                {a.ocrStatus === 'pending' || a.ocrStatus === 'processing' ? ' · reading text…' : ''}
                {a.ocrStatus === 'failed' ? ' · text not readable' : ''}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Revisions({ eventId, tz }: { eventId: string; tz: string }) {
  const q = useQuery({ queryKey: ['revisions', eventId], queryFn: () => api<{ items: RevisionDTO[] }>(`/events/${eventId}/revisions`) });
  if (!q.data) return <Loading />;
  return (
    <ol className="plain-list" reversed>
      {q.data.items.map((r) => (
        <li key={r.revision}>
          <strong>Revision {r.revision}</strong> — {r.changeKind === 'create' ? 'recorded' : r.changeKind === 'update' ? `changed ${r.changedFields.join(', ')}` : r.changeKind === 'delete' ? 'moved to trash' : 'restored'}{' '}
          <span className="muted">
            by {r.createdBy?.displayName ?? 'unknown'} on {formatDateTime(r.createdAt, tz)}
            {r.createdVia === 'mcp' ? ' (through a connected application)' : ''}
          </span>
          <div className="small">
            <TimestampStatus ts={r.timestamp} />
          </div>
          <details className="small">
            <summary>Technical details</summary>
            <p>
              SHA-256: <span className="mono">{r.sha256}</span>
            </p>
            {r.previousSha256 ? (
              <p>
                Previous revision: <span className="mono">{r.previousSha256}</span>
              </p>
            ) : null}
            {r.timestamp?.status === 'pending' || r.timestamp?.status === 'complete' ? (
              <p>
                <a href={apiUrl(`/events/${eventId}/revisions/${r.revision}/timestamp.ots`)} download>
                  Download OpenTimestamps proof (.ots)
                </a>
              </p>
            ) : null}
            {r.canonical ? (
              <pre className="ocr-text" tabIndex={0} aria-label={`Canonical JSON of revision ${r.revision}`}>
                {JSON.stringify(JSON.parse(r.canonical), null, 2)}
              </pre>
            ) : null}
          </details>
        </li>
      ))}
    </ol>
  );
}

export function EventDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const record = useRecord();
  const tz = record.data?.timezone ?? 'Europe/London';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['event', id],
    queryFn: () => api<EventDetailDTO>(`/events/${id}`),
    // Poll while text recognition is still running so results appear without a reload.
    refetchInterval: (query) => (query.state.data?.attachments.some((a) => a.ocrStatus === 'pending' || a.ocrStatus === 'processing' || a.derivativeStatus === 'pending') ? 4000 : false),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [incidentDialog, setIncidentDialog] = useState(false);
  const [relateDialog, setRelateDialog] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<unknown>(null);
  usePageTitle(q.data?.displayTitle ?? 'Event');
  if (q.error) return <ErrorSummary error={q.error} />;
  if (!q.data) return <Loading />;
  const e = q.data;
  const amount = money(e.amount, e.currency);
  const refresh = () => qc.invalidateQueries();

  return (
    <>
      {params.get('captured') ? <Alert kind="success" title="Letter saved">The pages are stored as originals. Text is being read from them now.</Alert> : null}
      <PageHeader
        title={e.displayTitle}
        lede={
          <span className="row">
            <Icon name={TYPE_ICONS[e.type.key] ?? 'file'} /> {e.type.label} · {formatWhen(e.occurredAt, e.occurredPrecision, tz)}
          </span>
        }
        actions={
          <>
            {e.permissions.canEdit ? (
              <Link className="btn" to={`/events/${e.id}/edit`}>
                Edit
              </Link>
            ) : null}
            {e.permissions.canOrganise ? (
              <button type="button" className="btn" onClick={() => setIncidentDialog(true)}>
                <Icon name="incident" /> Add to Incident
              </button>
            ) : null}
            {e.permissions.canOrganise ? (
              <button type="button" className="btn" onClick={() => setRelateDialog(true)}>
                <Icon name="link" /> Relate
              </button>
            ) : null}
          </>
        }
      />
      <div className="layout-sidebar">
        <div className="stack">
          <section className="card" aria-labelledby="about-h">
            <h2 id="about-h">About this Event</h2>
            <dl className="details">
              <dt>Happened</dt>
              <dd>
                {formatWhen(e.occurredAt, e.occurredPrecision, tz)}
                {e.endedAt ? ` until ${formatWhen(e.endedAt, 'datetime', tz)}` : ''}
              </dd>
              <dt>Recorded</dt>
              <dd>
                {formatDateTime(e.recordedAt, tz)} by {e.createdBy?.displayName ?? 'unknown'}
                {e.createdVia === 'mcp' ? ' through a connected application' : ''}
              </dd>
              <dt>Actors</dt>
              <dd>
                {e.actors.length ? (
                  <ul className="plain-list">
                    {e.actors.map((a, i) =>
                      a.redacted ? (
                        <li key={`r${i}`} className="muted">
                          Another Actor, not shared with you
                        </li>
                      ) : (
                        <li key={a.id}>
                          <Link to={`/actors/${a.id}`}>{a.name}</Link>
                          {a.role ? <span className="muted"> — {a.role}</span> : null}
                        </li>
                      ),
                    )}
                  </ul>
                ) : (
                  <span className="muted">None recorded</span>
                )}
              </dd>
              {e.direction ? (
                <>
                  <dt>Direction</dt>
                  <dd>{DIRECTION_LABEL[e.direction]}</dd>
                </>
              ) : null}
              {amount ? (
                <>
                  <dt>Amount</dt>
                  <dd>{amount}</dd>
                </>
              ) : null}
              {e.reference ? (
                <>
                  <dt>Reference</dt>
                  <dd>{e.reference}</dd>
                </>
              ) : null}
              {e.dueOn ? (
                <>
                  <dt>Due</dt>
                  <dd>{new Date(`${e.dueOn}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</dd>
                </>
              ) : null}
              {e.riskLevel !== 'none' ? (
                <>
                  <dt>Risk</dt>
                  <dd>
                    <RiskBadge level={e.riskLevel} /> {e.riskNote}
                  </dd>
                </>
              ) : null}
              {e.tags.length ? (
                <>
                  <dt>Tags</dt>
                  <dd>{e.tags.join(', ')}</dd>
                </>
              ) : null}
            </dl>
            {e.description ? (
              <>
                <h3>Notes</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{e.description}</p>
              </>
            ) : null}
          </section>

          <section className="card" aria-labelledby="att-h">
            <h2 id="att-h">Attachments ({e.attachments.length})</h2>
            {e.attachments.length ? <AttachmentGallery items={e.attachments} eventTitle={e.displayTitle} /> : <p className="muted">No attachments.</p>}
            {e.permissions.canAddAttachment ? (
              <div className="field" style={{ marginTop: '1rem' }}>
                <label htmlFor="add-files">Add files</label>
                <span className="hint">Photos, PDFs, screenshots, emails (.eml) or documents.</span>
                <input
                  id="add-files"
                  type="file"
                  multiple
                  onChange={async (ev) => {
                    const files = [...(ev.target.files ?? [])];
                    ev.target.value = '';
                    setUploadError(null);
                    for (const [i, f] of files.entries()) {
                      setUploading(`Uploading ${i + 1} of ${files.length}: ${f.name}`);
                      try {
                        await uploadFile(`/events/${e.id}/attachments`, f);
                      } catch (err) {
                        setUploadError(err);
                      }
                    }
                    setUploading(null);
                    await refresh();
                    toast('Files added');
                  }}
                />
                <p role="status" className="muted small">
                  {uploading}
                </p>
                <ErrorSummary error={uploadError} />
              </div>
            ) : null}
          </section>

          <section className="card" aria-labelledby="rev-h">
            <h2 id="rev-h">History and integrity</h2>
            <p>
              <TimestampStatus ts={e.currentRevision?.timestamp ?? null} />
            </p>
            <details>
              <summary>Revision history ({e.revision})</summary>
              <Revisions eventId={e.id} tz={tz} />
            </details>
          </section>
        </div>

        <aside className="stack" aria-label="Related">
          <section className="card" aria-labelledby="inc-h">
            <h2 id="inc-h">Incidents</h2>
            {e.incidents.length ? (
              <ul className="plain-list">
                {e.incidents.map((i) => (
                  <li key={i.id}>
                    <Link to={`/incidents/${i.id}`}>{i.title}</Link> <span className="muted small">({i.status})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Not part of any Incident.</p>
            )}
          </section>
          <section className="card" aria-labelledby="rel-h">
            <h2 id="rel-h">Related Events</h2>
            {e.related.length ? (
              <ul className="plain-list">
                {e.related.map((r) => (
                  <li key={r.relationId}>
                    <Link to={`/events/${r.id}`}>{r.displayTitle}</Link>
                    <div className="muted small">
                      {formatWhen(r.occurredAt, r.occurredPrecision, tz)}
                      {r.note ? ` — ${r.note}` : ''}
                    </div>
                    {e.permissions.canOrganise ? (
                      <button
                        type="button"
                        className="link-button small"
                        onClick={async () => {
                          await api(`/relations/${r.relationId}`, { method: 'DELETE' });
                          await refresh();
                          toast('Relationship removed');
                        }}
                      >
                        Remove relationship<span className="visually-hidden"> with {r.displayTitle}</span>
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None.</p>
            )}
          </section>
          {e.permissions.canDelete ? (
            <section className="card">
              <h2>Delete</h2>
              <p className="small">Deleted Events go to the trash and can be restored for a limited time.</p>
              <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" /> Move to trash
              </button>
            </section>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Move this Event to the trash?"
        body={<p>“{e.displayTitle}” and its attachments will be hidden from your record. You can restore them from Settings → Storage → Trash until they are permanently removed.</p>}
        confirmLabel="Move to trash"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api(`/events/${e.id}`, { method: 'DELETE' });
          await refresh();
          toast('Event moved to trash');
          navigate('/');
        }}
      />
      <AddToIncidentDialog open={incidentDialog} onClose={() => setIncidentDialog(false)} eventIds={[e.id]} onDone={refresh} />
      <RelateDialog open={relateDialog} onClose={() => setRelateDialog(false)} eventId={e.id} onDone={refresh} />
    </>
  );
}

export function AddToIncidentDialog({ open, onClose, eventIds, onDone }: { open: boolean; onClose: () => void; eventIds: string[]; onDone: () => void }) {
  const incidents = useQuery({ queryKey: ['incidents', 'pick'], queryFn: () => api<{ items: IncidentDTO[] }>('/incidents'), enabled: open });
  const [choice, setChoice] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState<unknown>(null);
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <Dialog
      open={open}
      title="Add to an Incident"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              setError(null);
              try {
                if (choice === 'new') {
                  const inc = await api<IncidentDTO>('/incidents', { method: 'POST', body: { title: newTitle, eventIds } });
                  onClose();
                  onDone();
                  navigate(`/incidents/${inc.id}`);
                } else if (choice) {
                  await api(`/incidents/${choice}/events`, { method: 'POST', body: { eventIds } });
                  toast('Added to Incident');
                  onClose();
                  onDone();
                }
              } catch (err) {
                setError(err);
              }
            }}
          >
            Add
          </button>
        </>
      }
    >
      <ErrorSummary error={error} />
      <SelectField
        label="Incident"
        value={choice}
        onChange={setChoice}
        options={[{ value: '', label: 'Choose…' }, { value: 'new', label: 'Create a new Incident' }, ...(incidents.data?.items ?? []).map((i) => ({ value: i.id, label: `${i.title} (${i.status})` }))]}
      />
      {choice === 'new' ? <TextField label="New Incident title" value={newTitle} onChange={setNewTitle} hint="For example “Incorrect credit card arrears”." /> : null}
    </Dialog>
  );
}

function RelateDialog({ open, onClose, eventId, onDone }: { open: boolean; onClose: () => void; eventId: string; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const results = useQuery({
    queryKey: ['relate-search', q],
    queryFn: () => api<{ items: { id: string; displayTitle: string; occurredAt: string }[] }>('/events', { query: { q, limit: 10 } }),
    enabled: open && q.length > 1,
  });
  const toast = useToast();
  return (
    <Dialog open={open} title="Relate to another Event" onClose={onClose} actions={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <ErrorSummary error={error} />
      <TextField label="Find an Event" value={q} onChange={setQ} hint="Type words from its title, notes or Actors." />
      <TextField label="Note about the relationship" optional value={note} onChange={setNote} />
      <ul className="option-list" aria-label="Matching Events">
        {(results.data?.items ?? [])
          .filter((r) => r.id !== eventId)
          .map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={async () => {
                  setError(null);
                  try {
                    await api(`/events/${eventId}/relations`, { method: 'POST', body: { eventId: r.id, note: note || null } });
                    toast('Events related');
                    onDone();
                    onClose();
                  } catch (err) {
                    setError(err);
                  }
                }}
              >
                Relate to “{r.displayTitle}” <span className="muted small">({new Date(r.occurredAt).toLocaleDateString('en-GB')})</span>
              </button>
            </li>
          ))}
      </ul>
    </Dialog>
  );
}
