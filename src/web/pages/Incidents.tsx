import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { EventSummaryDTO, IncidentDTO } from '../../shared/types';
import { RiskBadge } from '../components/EventList';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toasts';
import {
  Alert,
  ConfirmDialog,
  ErrorSummary,
  fieldError,
  Loading,
  SelectField,
  TextField,
} from '../components/ui';
import { api, uploadFile } from '../lib/api';
import { useRecord } from '../lib/auth';
import { formatDate, STATUS_LABEL } from '../lib/format';
import { usePageTitle } from '../lib/hooks';
import { AttachmentGallery } from './EventDetail';
import { TimelineFilters, type TimelineFilterState } from './Timeline';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function IncidentsPage() {
  usePageTitle('Incidents');
  const record = useRecord();
  const [status, setStatus] = useState('');
  const q = useQuery({
    queryKey: ['incidents', status],
    queryFn: () =>
      api<{ items: IncidentDTO[]; total: number }>('/incidents', {
        query: { status: status || undefined },
      }),
  });
  return (
    <>
      <PageHeader
        title="Incidents"
        lede="Incidents group related Events where something has gone wrong or needs attention. Most Events never need one."
        actions={
          record.data?.capabilities.organise ? (
            <Link className="btn btn-primary" to="/incidents/new">
              <Icon name="plus" /> New Incident
            </Link>
          ) : null
        }
      />
      <div style={{ maxWidth: '20rem' }}>
        <SelectField
          label="Show"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All Incidents' },
            { value: 'open', label: 'Open' },
            { value: 'monitoring', label: 'Monitoring' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>
      {q.isLoading ? <Loading /> : null}
      <ErrorSummary error={q.error} />
      {q.data && !q.data.items.length ? (
        <div className="empty">No Incidents{status ? ' with this status' : ''}.</div>
      ) : null}
      <ul className="timeline">
        {q.data?.items.map((i) => (
          <li key={i.id}>
            <article className="event-card" aria-labelledby={`inc-${i.id}`}>
              <div className="event-card__date">
                <strong>{formatDate(i.openedOn)}</strong>
                {i.closedOn ? `to ${formatDate(i.closedOn)}` : 'ongoing'}
              </div>
              <div>
                <h2
                  className="event-card__title"
                  id={`inc-${i.id}`}
                  style={{ fontSize: '1.05rem', margin: 0 }}
                >
                  <Link to={`/incidents/${i.id}`}>{i.title}</Link>
                </h2>
                <div className="event-card__meta">
                  <StatusBadge status={i.status} />
                  <span>
                    {i.eventCount} Event{i.eventCount === 1 ? '' : 's'}
                  </span>
                  <RiskBadge level={i.highestRisk} />
                </div>
                {i.description ? (
                  <p className="event-card__summary">{i.description.slice(0, 200)}</p>
                ) : null}
              </div>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

export function IncidentForm({ incident }: { incident?: IncidentDTO }) {
  const [params] = useSearchParams();
  const [title, setTitle] = useState(incident?.title ?? '');
  const [description, setDescription] = useState(incident?.description ?? '');
  const [status, setStatus] = useState<string>(incident?.status ?? 'open');
  const [openedOn, setOpenedOn] = useState(incident?.openedOn ?? '');
  const [closedOn, setClosedOn] = useState(incident?.closedOn ?? '');
  const [impact, setImpact] = useState(incident?.impactSummary ?? '');
  const [outcome, setOutcome] = useState(incident?.outcomeNotes ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const eventIds = params.getAll('eventId');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        title,
        description,
        status,
        openedOn: openedOn || undefined,
        closedOn: closedOn || null,
        impactSummary: impact || null,
        outcomeNotes: outcome || null,
      };
      const saved = incident
        ? await api<IncidentDTO>(`/incidents/${incident.id}`, { method: 'PATCH', body })
        : await api<IncidentDTO>('/incidents', {
            method: 'POST',
            body: { ...body, closedOn: closedOn || undefined, eventIds },
          });
      await qc.invalidateQueries();
      navigate(`/incidents/${saved.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} noValidate className="stack">
      <ErrorSummary error={error} />
      {eventIds.length ? (
        <Alert kind="info">
          {eventIds.length} selected Event(s) will be added to this Incident.
        </Alert>
      ) : null}
      <TextField
        label="Title"
        value={title}
        onChange={setTitle}
        hint="For example “Incorrect credit card arrears”."
        error={fieldError(error, 'title')}
      />
      <TextField
        label="Description"
        optional
        multiline
        value={description}
        onChange={setDescription}
      />
      <SelectField
        label="Status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'monitoring', label: 'Monitoring' },
          { value: 'resolved', label: 'Resolved' },
          { value: 'closed', label: 'Closed' },
        ]}
      />
      <TextField
        label="Date opened"
        optional
        type="date"
        value={openedOn}
        onChange={setOpenedOn}
        hint={incident ? undefined : 'Leave blank to use the date of the earliest Event.'}
        error={fieldError(error, 'openedOn')}
      />
      <TextField
        label="Date closed"
        optional
        type="date"
        value={closedOn}
        onChange={setClosedOn}
        error={fieldError(error, 'closedOn')}
      />
      <TextField
        label="Impact"
        optional
        multiline
        rows={3}
        value={impact}
        onChange={setImpact}
        hint="How this has affected you, in your own words."
      />
      <TextField
        label="Outcome or remediation"
        optional
        multiline
        rows={3}
        value={outcome}
        onChange={setOutcome}
      />
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {incident ? 'Save changes' : 'Create Incident'}
        </button>
        <Link className="btn btn-ghost" to={incident ? `/incidents/${incident.id}` : '/incidents'}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

export function NewIncidentPage() {
  usePageTitle('New Incident');
  return (
    <>
      <PageHeader title="New Incident" />
      <IncidentForm />
    </>
  );
}

export function EditIncidentPage() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ['incident', id],
    queryFn: () => api<IncidentDTO>(`/incidents/${id}`),
  });
  usePageTitle('Edit Incident');
  if (!q.data) return q.error ? <ErrorSummary error={q.error} /> : <Loading />;
  return (
    <>
      <PageHeader title={`Edit: ${q.data.title}`} />
      <IncidentForm incident={q.data} />
    </>
  );
}

function AddExistingEvents({ incidentId, onDone }: { incidentId: string; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const results = useQuery({
    queryKey: ['add-existing', q],
    queryFn: () =>
      api<{ items: EventSummaryDTO[] }>('/events', { query: { q: q || undefined, limit: 20 } }),
  });
  return (
    <section className="card" aria-labelledby="add-existing-h">
      <h2 id="add-existing-h">Add existing Events</h2>
      <ErrorSummary error={error} />
      <TextField
        label="Find Events"
        value={q}
        onChange={setQ}
        hint="Search by words, or leave blank to see recent Events."
      />
      <fieldset>
        <legend>Choose Events to add</legend>
        {(results.data?.items ?? [])
          .filter((e) => !e.incidents.some((i) => i.id === incidentId))
          .map((e) => (
            <div className="choice" key={e.id}>
              <input
                id={`pick-${e.id}`}
                type="checkbox"
                checked={selected.includes(e.id)}
                onChange={(ev) =>
                  setSelected(
                    ev.target.checked ? [...selected, e.id] : selected.filter((x) => x !== e.id),
                  )
                }
              />
              <label htmlFor={`pick-${e.id}`}>
                {e.displayTitle}{' '}
                <span className="muted small">
                  — {new Date(e.occurredAt).toLocaleDateString('en-GB')}
                </span>
              </label>
            </div>
          ))}
      </fieldset>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!selected.length}
        onClick={async () => {
          setError(null);
          try {
            const r = await api<{ added: number }>(`/incidents/${incidentId}/events`, {
              method: 'POST',
              body: { eventIds: selected },
            });
            toast(`${r.added} Event(s) added`);
            setSelected([]);
            onDone();
          } catch (err) {
            setError(err);
          }
        }}
      >
        Add {selected.length || ''} selected
      </button>
    </section>
  );
}

export function IncidentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const record = useRecord();
  const q = useQuery({
    queryKey: ['incident', id],
    queryFn: () => api<IncidentDTO>(`/incidents/${id}`),
  });
  const [filters, setFilters] = useState<TimelineFilterState>({ order: 'asc' });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EventSummaryDTO | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timeline = useQuery({
    queryKey: ['incident-events', id, filters],
    queryFn: () =>
      api<{ items: EventSummaryDTO[] }>('/events', {
        query: {
          incidentId: id,
          order: filters.order,
          limit: 200,
          from: filters.from,
          to: filters.to,
          typeId: filters.typeId,
          actorId: filters.actorId,
          risk: filters.risk,
          q: filters.q,
        },
      }),
  });
  usePageTitle(q.data?.title ?? 'Incident');
  useEffect(() => setAdding(false), [id]);
  if (q.error) return <ErrorSummary error={q.error} />;
  if (!q.data) return <Loading />;
  const i = q.data;
  const canEdit = i.canEdit;
  return (
    <>
      <PageHeader
        title={i.title}
        lede={
          <span className="row">
            <StatusBadge status={i.status} /> Opened {formatDate(i.openedOn)}
            {i.closedOn ? `, closed ${formatDate(i.closedOn)}` : ''} · {i.eventCount} Event
            {i.eventCount === 1 ? '' : 's'}
          </span>
        }
        actions={
          canEdit ? (
            <>
              <Link className="btn" to={`/incidents/${i.id}/edit`}>
                Edit
              </Link>
              <button
                type="button"
                className="btn"
                onClick={() => setAdding((x) => !x)}
                aria-expanded={adding}
              >
                <Icon name="plus" /> Add existing Events
              </button>
            </>
          ) : null
        }
      />
      {i.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{i.description}</p> : null}
      {i.impactSummary || i.outcomeNotes ? (
        <div className="grid-2">
          {i.impactSummary ? (
            <section className="card">
              <h2>Impact</h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{i.impactSummary}</p>
            </section>
          ) : null}
          {i.outcomeNotes ? (
            <section className="card">
              <h2>Outcome</h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{i.outcomeNotes}</p>
            </section>
          ) : null}
        </div>
      ) : null}
      {adding ? (
        <AddExistingEvents incidentId={i.id} onDone={() => qc.invalidateQueries()} />
      ) : null}
      <h2>Timeline</h2>
      <TimelineFilters value={filters} onApply={setFilters} hide={['incident']} />
      {timeline.data ? (
        timeline.data.items.length ? (
          <ol className="timeline">
            {timeline.data.items.map((e) => (
              <li key={e.id}>
                <article className="event-card" aria-labelledby={`ie-${e.id}`}>
                  <div className="event-card__date">
                    <strong>
                      {new Date(e.occurredAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        timeZone: record.data?.timezone,
                      })}
                    </strong>
                  </div>
                  <div>
                    <h3 className="event-card__title" id={`ie-${e.id}`}>
                      <Link to={`/events/${e.id}`}>{e.displayTitle}</Link>
                    </h3>
                    <div className="event-card__meta">
                      <span className="type">{e.type.label}</span>
                      <RiskBadge level={e.riskLevel} />
                      {e.attachmentCount ? <span>{e.attachmentCount} attachment(s)</span> : null}
                    </div>
                    {e.summary ? <p className="event-card__summary">{e.summary}</p> : null}
                    {canEdit ? (
                      <button
                        type="button"
                        className="link-button small"
                        style={{ position: 'relative', zIndex: 1 }}
                        onClick={() => setRemoving(e)}
                      >
                        Remove from Incident
                        <span className="visually-hidden">: {e.displayTitle}</span>
                      </button>
                    ) : null}
                  </div>
                </article>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty">No Events in this Incident yet.</div>
        )
      ) : (
        <Loading />
      )}
      <section aria-labelledby="inc-att-h">
        <h2 id="inc-att-h">Incident attachments</h2>
        <p className="muted small">
          For documents about the Incident as a whole, such as a complaint summary. Documents about
          a particular Event belong on that Event.
        </p>
        {i.attachments?.length ? (
          <AttachmentGallery items={i.attachments} eventTitle={i.title} />
        ) : (
          <p className="muted">None.</p>
        )}
        {canEdit ? (
          <div className="field">
            <label htmlFor="inc-files">Add files to the Incident</label>
            <input
              id="inc-files"
              type="file"
              multiple
              onChange={async (ev) => {
                for (const f of [...(ev.target.files ?? [])])
                  await uploadFile(`/incidents/${i.id}/attachments`, f).catch(() => undefined);
                ev.target.value = '';
                await qc.invalidateQueries();
                toast('Files added');
              }}
            />
          </div>
        ) : null}
      </section>
      {canEdit ? (
        <p style={{ marginTop: '2rem' }}>
          <button
            type="button"
            className="btn btn-danger btn-small"
            onClick={() => setConfirmDelete(true)}
          >
            Delete Incident
          </button>
        </p>
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this Event from the Incident?"
        body={
          <p>
            “{removing?.displayTitle}” stays in your record; it is only removed from this Incident.
          </p>
        }
        confirmLabel="Remove from Incident"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          await api(`/incidents/${i.id}/events/${removing!.id}`, { method: 'DELETE' });
          setRemoving(null);
          await qc.invalidateQueries();
          toast('Removed from Incident');
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this Incident?"
        body={<p>The Incident grouping is moved to the trash. Its Events are not deleted.</p>}
        confirmLabel="Delete Incident"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api(`/incidents/${i.id}`, { method: 'DELETE' });
          await qc.invalidateQueries();
          navigate('/incidents');
        }}
      />
    </>
  );
}
