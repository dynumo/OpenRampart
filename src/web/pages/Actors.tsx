import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ActorDTO, IncidentRef } from '../../shared/types';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toasts';
import {
  Alert,
  Checkbox,
  ConfirmDialog,
  ErrorSummary,
  fieldError,
  Loading,
  SelectField,
  TextField,
} from '../components/ui';
import { api } from '../lib/api';
import { useRecord } from '../lib/auth';
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/hooks';
import { EventPages, readFilters, TimelineFilters, type TimelineFilterState } from './Timeline';

type ActorDetail = ActorDTO & {
  openIncidents: IncidentRef[];
  mergedFrom: { id: string; name: string }[];
};

export function ActorsPage() {
  usePageTitle('Actors');
  const record = useRecord();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('name');
  const [archived, setArchived] = useState(false);
  const list = useQuery({
    queryKey: ['actors', q, sort, archived],
    queryFn: () =>
      api<{ items: ActorDTO[]; total: number }>('/actors', {
        query: { q: q || undefined, sort, archived: archived ? 'true' : undefined, limit: 500 },
      }),
  });
  return (
    <>
      <PageHeader
        title="Actors"
        lede="The organisations and people involved in your Events."
        actions={
          record.data?.capabilities.add ? (
            <>
              <Link className="btn btn-primary" to="/actors/new">
                <Icon name="plus" /> New Actor
              </Link>
              {record.data.capabilities.organise ? (
                <Link className="btn" to="/actors/merge">
                  Merge duplicates
                </Link>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="filters">
        <div className="filters-grid">
          <div className="field">
            <label htmlFor="actor-q">Find an Actor</label>
            <input
              id="actor-q"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-describedby="actor-count"
            />
          </div>
          <SelectField
            label="Sort by"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'recent', label: 'Most recent interaction' },
            ]}
          />
        </div>
        <Checkbox label="Include archived Actors" checked={archived} onChange={setArchived} />
      </div>
      <p id="actor-count" className="muted small" role="status">
        {list.data ? `${list.data.total} Actor${list.data.total === 1 ? '' : 's'}` : ''}
      </p>
      {list.isLoading ? <Loading /> : null}
      <ErrorSummary error={list.error} />
      {list.data && !list.data.items.length ? (
        <div className="empty">No Actors yet. They are added when you record Events.</div>
      ) : null}
      <div className="table-wrap">
        {list.data?.items.length ? (
          <table>
            <caption className="visually-hidden">Actors</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Events</th>
                <th scope="col">Most recent</th>
                <th scope="col">Open Incidents</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <th scope="row">
                    <Link to={`/actors/${a.id}`}>{a.name}</Link>
                    {a.archivedAt ? (
                      <span className="badge" style={{ marginLeft: '0.5rem' }}>
                        Archived
                      </span>
                    ) : null}
                    {a.kind === 'person' ? <span className="muted small"> (person)</span> : null}
                  </th>
                  <td>{a.stats.eventCount}</td>
                  <td>
                    {a.stats.lastEventAt
                      ? formatDate(a.stats.lastEventAt, record.data?.timezone)
                      : '—'}
                  </td>
                  <td>{a.stats.openIncidentCount || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}

export function ActorForm({ actor }: { actor?: ActorDetail }) {
  const [name, setName] = useState(actor?.name ?? '');
  const [kind, setKind] = useState<string>(actor?.kind ?? 'organisation');
  const [aliases, setAliases] = useState(actor?.aliases.join(', ') ?? '');
  const [description, setDescription] = useState(actor?.description ?? '');
  const [accountReference, setAccountReference] = useState(actor?.accountReference ?? '');
  const [website, setWebsite] = useState(actor?.website ?? '');
  const [email, setEmail] = useState(actor?.email ?? '');
  const [phone, setPhone] = useState(actor?.phone ?? '');
  const [address, setAddress] = useState(actor?.address ?? '');
  const [error, setError] = useState<unknown>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      name,
      kind,
      aliases: aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      description,
      accountReference,
      website,
      email,
      phone,
      address,
    };
    try {
      const saved = actor
        ? await api<ActorDTO>(`/actors/${actor.id}`, { method: 'PATCH', body })
        : await api<ActorDTO>('/actors', { method: 'POST', body });
      await qc.invalidateQueries();
      navigate(`/actors/${saved.id}`);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <form onSubmit={submit} noValidate className="stack">
      <ErrorSummary error={error} />
      <TextField label="Name" value={name} onChange={setName} error={fieldError(error, 'name')} />
      <SelectField
        label="Kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'organisation', label: 'Organisation' },
          { value: 'person', label: 'Person' },
          { value: 'other', label: 'Other' },
        ]}
      />
      <TextField
        label="Other names"
        optional
        hint="Separate with commas, e.g. “HMRC, H.M.R.C.” — these help search."
        value={aliases}
        onChange={setAliases}
      />
      <TextField
        label="Your account or reference number with them"
        optional
        value={accountReference}
        onChange={setAccountReference}
      />
      <TextField label="Website" optional type="url" value={website} onChange={setWebsite} />
      <TextField label="Email" optional type="email" value={email} onChange={setEmail} />
      <TextField label="Phone" optional type="tel" value={phone} onChange={setPhone} />
      <TextField
        label="Address"
        optional
        multiline
        rows={3}
        value={address}
        onChange={setAddress}
      />
      <TextField
        label="Notes"
        optional
        multiline
        rows={4}
        value={description}
        onChange={setDescription}
      />
      <div className="row">
        <button type="submit" className="btn btn-primary">
          {actor ? 'Save changes' : 'Create Actor'}
        </button>
        <Link to={actor ? `/actors/${actor.id}` : '/actors'} className="btn btn-ghost">
          Cancel
        </Link>
      </div>
    </form>
  );
}

export function NewActorPage() {
  usePageTitle('New Actor');
  return (
    <>
      <PageHeader title="New Actor" />
      <ActorForm />
    </>
  );
}

export function EditActorPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['actor', id], queryFn: () => api<ActorDetail>(`/actors/${id}`) });
  usePageTitle('Edit Actor');
  if (!q.data) return q.error ? <ErrorSummary error={q.error} /> : <Loading />;
  return (
    <>
      <PageHeader title={`Edit: ${q.data.name}`} />
      <ActorForm actor={q.data} />
    </>
  );
}

export function ActorDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const record = useRecord();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ['actor', id], queryFn: () => api<ActorDetail>(`/actors/${id}`) });
  const [confirmDelete, setConfirmDelete] = useState(false);
  usePageTitle(q.data?.name ?? 'Actor');
  if (q.error) return <ErrorSummary error={q.error} />;
  if (!q.data) return <Loading />;
  const a = q.data;
  if (a.mergedIntoId) {
    return (
      <Alert kind="info" title={`${a.name} was merged`}>
        <p>
          This Actor was merged into another.{' '}
          <Link to={`/actors/${a.mergedIntoId}`}>Go to the merged Actor</Link>.
        </p>
      </Alert>
    );
  }
  const isOwner = record.data?.role === 'owner';
  const apply = (f: TimelineFilterState) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(f))
      if (v && !(k === 'order' && v === 'desc')) next.set(k, String(v));
    setParams(next);
  };
  return (
    <>
      <PageHeader
        title={a.name}
        lede={
          a.aliases.length
            ? `Also known as ${a.aliases.join(', ')}`
            : a.kind === 'person'
              ? 'Person'
              : a.kind === 'organisation'
                ? 'Organisation'
                : undefined
        }
        actions={
          a.fullAccess && (isOwner || record.data?.capabilities.add) ? (
            <Link className="btn" to={`/actors/${a.id}/edit`}>
              Edit
            </Link>
          ) : null
        }
      />
      {!a.fullAccess ? (
        <Alert kind="info">
          You can see this Actor because it appears on Events shared with you. Its details and other
          Events are not shared.
        </Alert>
      ) : null}
      <div className="layout-sidebar">
        <div>
          <h2 style={{ marginTop: 0 }}>Timeline</h2>
          <TimelineFilters value={filters} onApply={apply} hide={['actor']} />
          <EventPages
            filters={filters}
            extra={{ actorId: a.id }}
            emptyText="No Events with this Actor match."
          />
        </div>
        <aside className="stack" aria-label="About this Actor">
          <section className="card">
            <h2>Summary</h2>
            <dl className="details">
              <dt>Events</dt>
              <dd>{a.stats.eventCount}</dd>
              <dt>First</dt>
              <dd>
                {a.stats.firstEventAt
                  ? formatDate(a.stats.firstEventAt, record.data?.timezone)
                  : '—'}
              </dd>
              <dt>Most recent</dt>
              <dd>
                {a.stats.lastEventAt ? formatDate(a.stats.lastEventAt, record.data?.timezone) : '—'}
              </dd>
            </dl>
          </section>
          {a.openIncidents.length ? (
            <section className="card">
              <h2>Open Incidents</h2>
              <ul className="plain-list">
                {a.openIncidents.map((i) => (
                  <li key={i.id}>
                    <Link to={`/incidents/${i.id}`}>{i.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {a.fullAccess &&
          (a.accountReference || a.website || a.email || a.phone || a.address || a.description) ? (
            <section className="card">
              <h2>Details</h2>
              <dl className="details">
                {a.accountReference ? (
                  <>
                    <dt>Reference</dt>
                    <dd>{a.accountReference}</dd>
                  </>
                ) : null}
                {a.website ? (
                  <>
                    <dt>Website</dt>
                    <dd>
                      <a href={a.website} rel="noreferrer noopener" target="_blank">
                        {a.website}
                      </a>
                    </dd>
                  </>
                ) : null}
                {a.email ? (
                  <>
                    <dt>Email</dt>
                    <dd>{a.email}</dd>
                  </>
                ) : null}
                {a.phone ? (
                  <>
                    <dt>Phone</dt>
                    <dd>{a.phone}</dd>
                  </>
                ) : null}
                {a.address ? (
                  <>
                    <dt>Address</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>{a.address}</dd>
                  </>
                ) : null}
              </dl>
              {a.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{a.description}</p> : null}
            </section>
          ) : null}
          {a.mergedFrom.length ? (
            <section className="card">
              <h2>Merged from</h2>
              <ul>
                {a.mergedFrom.map((m) => (
                  <li key={m.id}>{m.name}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {isOwner ? (
            <section className="card">
              <h2>Manage</h2>
              <div className="stack">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={async () => {
                    await api(`/actors/${a.id}/archive`, {
                      method: 'POST',
                      body: { archived: !a.archivedAt },
                    });
                    await qc.invalidateQueries();
                    toast(a.archivedAt ? 'Actor restored to the active list' : 'Actor archived');
                  }}
                >
                  {a.archivedAt ? 'Unarchive' : 'Archive'}
                </button>
                <p className="small muted">
                  Archiving hides an Actor from pickers but keeps its history.
                </p>
                <Link className="btn btn-small" to={`/actors/merge?targetId=${a.id}`}>
                  Merge duplicates into this Actor
                </Link>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
              </div>
            </section>
          ) : null}
        </aside>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${a.name}?`}
        body={
          <p>
            Actors that appear on Events cannot be deleted, so the history stays intact — archive or
            merge them instead. An unused Actor is moved to the trash.
          </p>
        }
        confirmLabel="Delete Actor"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api(`/actors/${a.id}`, { method: 'DELETE' });
          await qc.invalidateQueries();
          navigate('/actors');
        }}
      />
    </>
  );
}

interface MergePreview {
  target: { id: string; name: string };
  sources: { id: string; name: string; eventCount: number }[];
  affectedHelpers: {
    relationshipId: string;
    label: string;
    grantId: string;
    actorsInGrant: string[];
  }[];
}

export function MergeActorsPage() {
  usePageTitle('Merge Actors');
  const [params] = useSearchParams();
  const all = useQuery({
    queryKey: ['actors', 'merge'],
    queryFn: () =>
      api<{ items: ActorDTO[] }>('/actors', { query: { limit: 500, archived: 'true' } }),
  });
  const [targetId, setTargetId] = useState(params.get('targetId') ?? '');
  const [sources, setSources] = useState<string[]>([]);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [extend, setExtend] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  if (!all.data) return <Loading />;
  const items = all.data.items.filter((a) => !a.mergedIntoId);
  return (
    <>
      <PageHeader
        title="Merge duplicate Actors"
        lede="Combine duplicates such as “HMRC”, “H.M.R.C.” and “HM Revenue & Customs” into one Actor. All Events and Incidents are kept."
      />
      <ErrorSummary error={error} />
      <SelectField
        label="Keep this Actor"
        value={targetId}
        onChange={(v) => {
          setTargetId(v);
          setPreview(null);
        }}
        options={[
          { value: '', label: 'Choose…' },
          ...items.map((a) => ({ value: a.id, label: `${a.name} (${a.stats.eventCount} Events)` })),
        ]}
      />
      <fieldset>
        <legend>Merge these duplicates into it</legend>
        {items
          .filter((a) => a.id !== targetId)
          .map((a) => (
            <Checkbox
              key={a.id}
              label={`${a.name} (${a.stats.eventCount} Events)`}
              checked={sources.includes(a.id)}
              onChange={(c) => {
                setSources(c ? [...sources, a.id] : sources.filter((s) => s !== a.id));
                setPreview(null);
              }}
            />
          ))}
      </fieldset>
      <button
        type="button"
        className="btn"
        disabled={!targetId || !sources.length}
        onClick={async () => {
          setError(null);
          try {
            setPreview(
              await api<MergePreview>('/actors/merge/preview', {
                method: 'POST',
                body: { targetId, sourceIds: sources },
              }),
            );
          } catch (err) {
            setError(err);
          }
        }}
      >
        Review merge
      </button>
      {preview ? (
        <section className="card" style={{ marginTop: '1rem' }} aria-labelledby="merge-review">
          <h2 id="merge-review">Review</h2>
          <p>
            {preview.sources.map((s) => `${s.name} (${s.eventCount} Events)`).join(', ')} will be
            merged into <strong>{preview.target.name}</strong>. Their names become “other names” of{' '}
            {preview.target.name}, and each affected Event gets a new revision.
          </p>
          {preview.affectedHelpers.length ? (
            <Alert kind="warning" title="Helpers are affected">
              <p>
                {preview.affectedHelpers.map((h) => h.label).join(', ')}{' '}
                {preview.affectedHelpers.length === 1 ? 'has' : 'have'} access based on one of these
                Actors. By default they keep seeing exactly the same Events as before — merging
                never widens or narrows their access on its own.
              </p>
              <Checkbox
                label="Also let these Helpers see the Events of all the merged Actors"
                checked={extend}
                onChange={setExtend}
              />
            </Alert>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => setConfirm(true)}>
            Merge Actors
          </button>
        </section>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title="Merge these Actors?"
        body={
          <p>
            This is recorded in the audit log. The merged Actors stay in the background so history
            and exports still make sense.
          </p>
        }
        confirmLabel="Merge"
        typeToConfirm="merge"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await api('/actors/merge', {
            method: 'POST',
            body: { targetId, sourceIds: sources, extendHelperAccess: extend },
          });
          await qc.invalidateQueries();
          navigate(`/actors/${targetId}`);
        }}
      />
    </>
  );
}
