import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { localDateString, localDateTimeString } from '../../shared/dates';
import type { EventDetailDTO, EventTypeDTO, IncidentDTO } from '../../shared/types';
import { ActorPicker, toActorPayload, type PickedActor } from '../components/ActorPicker';
import { Icon, TYPE_ICONS } from '../components/Icon';
import { PageHeader } from '../components/Layout';
import { Alert, ErrorSummary, fieldError, Loading, SelectField, TextField } from '../components/ui';
import { useToast } from '../components/Toasts';
import { api, ApiError, uploadFile } from '../lib/api';
import { useAuth, useRecord } from '../lib/auth';
import { usePageTitle } from '../lib/hooks';
import { useEventTypes } from './Timeline';

const COMMON = [
  'letter_in',
  'phone_call',
  'email_in',
  'observation',
  'payment',
  'portal',
  'webchat',
  'note',
];

export function AddEventPage() {
  usePageTitle('Add Event');
  const types = useEventTypes();
  if (!types.data) return <Loading />;
  const live = types.data.items.filter((t) => !t.archived);
  const common = COMMON.map((k) => live.find((t) => t.key === k)).filter((t): t is EventTypeDTO =>
    Boolean(t),
  );
  const others = live.filter((t) => !COMMON.includes(t.key));
  return (
    <>
      <PageHeader
        title="Add Event"
        lede="What happened? Choose the closest match — you can change it later."
      />
      <h2 className="visually-hidden">Common Event types</h2>
      <ul className="type-grid">
        <li>
          <Link to="/events/new/letter">
            <Icon name="camera" />
            Photograph a letter
          </Link>
        </li>
        {common.map((t) => (
          <li key={t.key}>
            <Link to={`/events/new/${t.key}`}>
              <Icon name={TYPE_ICONS[t.key] ?? 'file'} />
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
      <h2>All other types</h2>
      <ul className="type-grid">
        {others.map((t) => (
          <li key={t.key}>
            <Link to={`/events/new/${t.key}`}>
              <Icon name={TYPE_ICONS[t.key] ?? 'file'} />
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

interface FormValues {
  typeId: string;
  title: string;
  date: string;
  time: string;
  hasTime: boolean;
  direction: string;
  description: string;
  actors: PickedActor[];
  riskLevel: string;
  riskNote: string;
  amount: string;
  currency: string;
  reference: string;
  dueOn: string;
  tags: string;
  incidentId: string;
}

function initialValues(tz: string, type?: EventTypeDTO, event?: EventDetailDTO): FormValues {
  if (event) {
    return {
      typeId: event.type.id,
      title: event.title,
      date: localDateString(new Date(event.occurredAt), tz),
      time:
        event.occurredPrecision === 'datetime'
          ? localDateTimeString(new Date(event.occurredAt), tz).slice(11)
          : '',
      hasTime: event.occurredPrecision === 'datetime',
      direction: event.direction ?? '',
      description: event.description,
      actors: event.actors
        .filter((a) => !a.redacted)
        .map((a) => ({
          actorId: (a as { id: string }).id,
          name: (a as { name: string }).name,
          role: a.role,
        })),
      riskLevel: event.riskLevel,
      riskNote: event.riskNote ?? '',
      amount: event.amount ?? '',
      currency: event.currency ?? 'GBP',
      reference: event.reference ?? '',
      dueOn: event.dueOn ?? '',
      tags: event.tags.join(', '),
      incidentId: '',
    };
  }
  const now = new Date();
  return {
    typeId: type?.id ?? '',
    title: '',
    date: localDateString(now, tz),
    time: localDateTimeString(now, tz).slice(11),
    hasTime: ['phone_call', 'webchat', 'portal', 'in_person', 'voicemail'].includes(
      type?.key ?? '',
    ),
    direction: type?.defaultDirection ?? '',
    description: '',
    actors: [],
    riskLevel: 'none',
    riskNote: '',
    amount: '',
    currency: 'GBP',
    reference: '',
    dueOn: '',
    tags: '',
    incidentId: '',
  };
}

function toPayload(v: FormValues, isEdit: boolean) {
  return {
    typeId: v.typeId,
    title: v.title,
    occurredAt: v.hasTime && v.time ? `${v.date}T${v.time}` : v.date,
    direction: v.direction || null,
    description: v.description,
    ...toActorPayload(v.actors),
    riskLevel: v.riskLevel,
    riskNote: v.riskLevel === 'none' ? null : v.riskNote || null,
    amount: v.amount || null,
    currency: v.amount ? v.currency || 'GBP' : null,
    reference: v.reference || null,
    dueOn: v.dueOn || null,
    tags: v.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    ...(isEdit ? {} : { incidentIds: v.incidentId ? [v.incidentId] : [] }),
  };
}

/** The full Event form, used for adding and correcting Events. */
export function EventForm({ event, typeKey }: { event?: EventDetailDTO; typeKey?: string }) {
  const types = useEventTypes();
  const record = useRecord();
  const { state } = useAuth();
  const tz = record.data?.timezone ?? 'Europe/London';
  const type = types.data?.items.find((t) => t.key === typeKey);
  const [v, setV] = useState<FormValues | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const fileId = useId();
  const incidents = useQuery({
    queryKey: ['incidents', 'form'],
    queryFn: () =>
      api<{ items: IncidentDTO[] }>('/incidents', { query: { status: ['open', 'monitoring'] } }),
    enabled: !event,
  });
  useEffect(() => {
    if (types.data && record.data && !v) setV(initialValues(tz, type, event));
  }, [types.data, record.data, v, tz, type, event]);
  if (!v || !types.data) return <Loading />;
  const set = <K extends keyof FormValues>(k: K, value: FormValues[K]) =>
    setV({ ...v, [k]: value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const payload = toPayload(v, Boolean(event));
      const saved = event
        ? await api<EventDetailDTO>(`/events/${event.id}`, { method: 'PATCH', body: payload })
        : await api<EventDetailDTO>('/events', { method: 'POST', body: payload });
      const failures: string[] = [];
      for (const [i, f] of files.entries()) {
        setProgress(`Uploading ${i + 1} of ${files.length}: ${f.name}`);
        try {
          await uploadFile(`/events/${saved.id}/attachments`, f);
        } catch (err) {
          failures.push(`${f.name}: ${(err as Error).message}`);
        }
      }
      setProgress(null);
      await qc.invalidateQueries();
      if (failures.length)
        toast(`Event saved, but some files were not uploaded: ${failures.join('; ')}`);
      else toast(event ? 'Event updated' : 'Event saved');
      navigate(`/events/${saved.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const typeOptions = types.data.items
    .filter((t) => !t.archived || t.id === v.typeId)
    .map((t) => ({ value: t.id, label: t.label }));
  return (
    <form onSubmit={submit} noValidate className="stack">
      <ErrorSummary error={error} />
      <SelectField
        label="Event type"
        value={v.typeId}
        onChange={(x) => set('typeId', x)}
        options={[{ value: '', label: 'Choose…' }, ...typeOptions]}
        error={fieldError(error, 'typeId')}
      />
      <TextField
        label="Title"
        optional
        hint="A short description, such as “Arrears letter” or “Called about refund”."
        value={v.title}
        onChange={(x) => set('title', x)}
        error={fieldError(error, 'title')}
        maxLength={300}
      />
      <fieldset>
        <legend>When did it happen?</legend>
        <span className="hint">Not when you are recording it — that is saved automatically.</span>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="ev-date">Date</label>
            <input
              id="ev-date"
              type="date"
              value={v.date}
              onChange={(e) => set('date', e.target.value)}
              aria-invalid={Boolean(fieldError(error, 'occurredAt')) || undefined}
            />
          </div>
          {v.hasTime ? (
            <div className="field">
              <label htmlFor="ev-time">Time</label>
              <input
                id="ev-time"
                type="time"
                value={v.time}
                onChange={(e) => set('time', e.target.value)}
                style={{ width: 'auto' }}
              />
            </div>
          ) : null}
        </div>
        {fieldError(error, 'occurredAt') ? (
          <span className="field-error">{fieldError(error, 'occurredAt')}</span>
        ) : null}
        <div className="choice">
          <input
            id="ev-hastime"
            type="checkbox"
            checked={v.hasTime}
            onChange={(e) => set('hasTime', e.target.checked)}
          />
          <label htmlFor="ev-hastime">I know the time</label>
        </div>
      </fieldset>
      <ActorPicker value={v.actors} onChange={(x) => set('actors', x)} showRoles />
      <TextField
        label="Notes"
        optional
        multiline
        rows={6}
        hint="What happened, who you spoke to, what was said or agreed."
        value={v.description}
        onChange={(x) => set('description', x)}
      />
      <fieldset>
        <legend>Risk</legend>
        <span className="hint">Optional. Note anything at stake, such as a deadline.</span>
        <SelectField
          label="Risk level"
          value={v.riskLevel}
          onChange={(x) => set('riskLevel', x)}
          options={[
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
        {v.riskLevel !== 'none' ? (
          <TextField
            label="Risk note"
            optional
            value={v.riskNote}
            onChange={(x) => set('riskNote', x)}
            hint="For example: “Confirmation statement due tomorrow.”"
          />
        ) : null}
      </fieldset>
      {!event ? (
        <div className="field">
          <label htmlFor={fileId}>Attachments</label>
          <span className="hint">
            Optional. Photos, PDFs, screenshots or documents. Up to {state?.maxUploadMb ?? 50} MB
            each.
          </span>
          <input
            id={fileId}
            type="file"
            multiple
            accept="image/*,application/pdf,.txt,.eml,.doc,.docx,.odt,.xls,.xlsx,.ods,audio/*"
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
          />
          {files.length ? <p className="small">{files.length} file(s) chosen</p> : null}
        </div>
      ) : null}
      <details>
        <summary>
          More details (direction, amount, reference, due date, tags{event ? '' : ', Incident'})
        </summary>
        <div className="stack" style={{ marginTop: '1rem' }}>
          <SelectField
            label="Direction"
            optional
            value={v.direction}
            onChange={(x) => set('direction', x)}
            options={[
              { value: '', label: 'Not specified' },
              { value: 'inbound', label: 'Inbound (to me)' },
              { value: 'outbound', label: 'Outbound (from me)' },
              { value: 'internal', label: 'Observation / internal' },
            ]}
          />
          <div className="row">
            <TextField
              label="Amount"
              optional
              inputMode="decimal"
              value={v.amount}
              onChange={(x) => set('amount', x)}
              error={fieldError(error, 'amount')}
            />
            <TextField
              label="Currency"
              value={v.currency}
              onChange={(x) => set('currency', x.toUpperCase())}
              maxLength={3}
              error={fieldError(error, 'currency')}
            />
          </div>
          <TextField
            label="Reference number"
            optional
            value={v.reference}
            onChange={(x) => set('reference', x)}
            hint="Account, case, claim or letter reference."
          />
          <TextField
            label="Deadline or due date"
            optional
            type="date"
            value={v.dueOn}
            onChange={(x) => set('dueOn', x)}
          />
          <TextField
            label="Tags"
            optional
            hint="Separate with commas."
            value={v.tags}
            onChange={(x) => set('tags', x)}
          />
          {!event ? (
            <SelectField
              label="Add to Incident"
              optional
              value={v.incidentId}
              onChange={(x) => set('incidentId', x)}
              options={[
                { value: '', label: 'None' },
                ...(incidents.data?.items ?? []).map((i) => ({ value: i.id, label: i.title })),
              ]}
            />
          ) : null}
        </div>
      </details>
      {progress ? (
        <p role="status" className="muted">
          {progress}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : event ? 'Save changes' : 'Save Event'}
        </button>
        <Link to={event ? `/events/${event.id}` : '/'} className="btn btn-ghost">
          Cancel
        </Link>
      </div>
      {event ? (
        <p className="small muted">
          Saving creates a new revision. The previous version is kept in the history.
        </p>
      ) : null}
    </form>
  );
}

export function NewEventPage() {
  const { typeKey } = useParams();
  const types = useEventTypes();
  const label = types.data?.items.find((t) => t.key === typeKey)?.label ?? 'Event';
  usePageTitle(`Add ${label}`);
  return (
    <>
      <PageHeader
        title={`Add: ${label}`}
        lede="Only the type and date are needed. Fill in what you know; you can add more later."
      />
      <EventForm typeKey={typeKey} />
    </>
  );
}

export function EditEventPage() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ['event', id],
    queryFn: () => api<EventDetailDTO>(`/events/${id}`),
  });
  usePageTitle('Edit Event');
  if (q.error) return <ErrorSummary error={q.error} />;
  if (!q.data) return <Loading />;
  if (!q.data.permissions.canEdit) return <Alert kind="warning">You cannot edit this Event.</Alert>;
  return (
    <>
      <PageHeader title={`Edit: ${q.data.displayTitle}`} />
      <EventForm event={q.data} />
    </>
  );
}

interface Page {
  file: File;
  url: string | null;
}

/**
 * Fast phone capture: photograph one or more pages, confirm the date and who
 * it is from, save. Everything else is optional and can be added later.
 */
export function CaptureLetterPage() {
  usePageTitle('Capture a letter');
  const record = useRecord();
  const { state } = useAuth();
  const tz = record.data?.timezone ?? 'Europe/London';
  const types = useEventTypes();
  const [pages, setPages] = useState<Page[]>([]);
  const [date, setDate] = useState(() => localDateString(new Date(), tz));
  const [actors, setActors] = useState<PickedActor[]>([]);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [savedEventId, setSavedEventId] = useState<string | null>(null);
  const [failed, setFailed] = useState<File[]>([]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const camId = useId();
  const pickId = useId();
  const letterType = useMemo(
    () => types.data?.items.find((t) => t.key === 'letter_in'),
    [types.data],
  );

  useEffect(() => () => pages.forEach((p) => p.url && URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const added = [...list].map((file) => ({
      file,
      // Browsers cannot preview HEIC/PDF inline; those show a labelled placeholder.
      url: /^image\/(jpeg|png|webp|gif)$/.test(file.type) ? URL.createObjectURL(file) : null,
    }));
    setPages((p) => [...p, ...added]);
    setStatus(
      `${added.length} page${added.length === 1 ? '' : 's'} added. ${pages.length + added.length} in total.`,
    );
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...pages];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setPages(next);
    setStatus(`Page moved to position ${i + d + 1}.`);
  };

  async function uploadAll(eventId: string, files: File[]) {
    const failures: File[] = [];
    for (const [i, f] of files.entries()) {
      setStatus(`Uploading page ${i + 1} of ${files.length}…`);
      try {
        await uploadFile(`/events/${eventId}/attachments`, f, (fr) =>
          setProgress((i + fr) / files.length),
        );
      } catch (err) {
        failures.push(f);
        setError(err);
      }
    }
    setProgress(1);
    return failures;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      let eventId = savedEventId;
      if (!eventId) {
        setStatus('Saving the Event…');
        const ev = await api<EventDetailDTO>('/events', {
          method: 'POST',
          body: {
            typeId: letterType?.id ?? 'letter_in',
            occurredAt: date,
            title,
            description: note,
            ...toActorPayload(actors),
          },
        });
        eventId = ev.id;
        setSavedEventId(ev.id);
      }
      const failures = await uploadAll(eventId, failed.length ? failed : pages.map((p) => p.file));
      setFailed(failures);
      await qc.invalidateQueries();
      if (!failures.length) navigate(`/events/${eventId}?captured=1`);
      else
        setStatus(
          `The Event is saved, but ${failures.length} page(s) did not upload. You can try again.`,
        );
    } catch (err) {
      setError(err);
      setStatus(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Capture a letter"
        lede="Photograph each page, check the date and who it is from, then save. Text is read from the pages automatically afterwards."
      />
      <form onSubmit={save} noValidate className="stack" style={{ maxWidth: '42rem' }}>
        <ErrorSummary error={error instanceof ApiError || error instanceof Error ? error : null} />
        {savedEventId ? (
          <Alert kind="info">
            The Event has been saved. Only the remaining pages will be uploaded.
          </Alert>
        ) : null}
        <section aria-labelledby="pages-h">
          <h2 id="pages-h" style={{ marginTop: 0 }}>
            1. Pages
          </h2>
          <div className="capture-hero">
            <input
              id={camId}
              className="file-input"
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <label htmlFor={camId} className="btn btn-primary">
              <Icon name="camera" />
              {pages.length ? 'Photograph another page' : 'Take a photo'}
            </label>
            <input
              id={pickId}
              className="file-input"
              type="file"
              accept="image/*,application/pdf,.heic,.heif"
              multiple
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <label htmlFor={pickId} className="btn">
              <Icon name="upload" />
              Choose photos or a PDF
            </label>
          </div>
          <p className="small muted">
            Up to {state?.maxUploadMb ?? 50} MB per page. The original files are kept exactly as
            taken.
          </p>
          {pages.length ? (
            <ol className="pages" aria-label="Pages in order">
              {pages.map((p, i) => (
                <li key={`${p.file.name}-${i}`} className="page-thumb">
                  {p.url ? (
                    <img src={p.url} alt={`Page ${i + 1} preview`} />
                  ) : (
                    <div className="placeholder">
                      Page {i + 1}: {p.file.name}
                    </div>
                  )}
                  <div className="row">
                    <span className="small">Page {i + 1}</span>
                    <span className="row">
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                        aria-label={`Move page ${i + 1} earlier`}
                      >
                        <Icon name="arrowUp" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        disabled={i === pages.length - 1}
                        onClick={() => move(i, 1)}
                        aria-label={`Move page ${i + 1} later`}
                      >
                        <Icon name="arrowDown" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        onClick={() => {
                          setPages(pages.filter((_, j) => j !== i));
                          setStatus(`Page ${i + 1} removed.`);
                        }}
                        aria-label={`Remove page ${i + 1}`}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
        <section aria-labelledby="details-h">
          <h2 id="details-h">2. Details</h2>
          <TextField
            label="Date on the letter, or when it arrived"
            type="date"
            value={date}
            onChange={setDate}
            error={fieldError(error, 'occurredAt')}
          />
          <ActorPicker
            value={actors}
            onChange={setActors}
            label="Who is it from?"
            hint="Type the organisation or person's name, then choose it or create it."
          />
          <TextField
            label="Title"
            optional
            value={title}
            onChange={setTitle}
            hint="For example “Council tax bill”."
          />
          <TextField label="Note" optional multiline rows={3} value={note} onChange={setNote} />
        </section>
        {progress > 0 && progress < 1 ? (
          <progress className="progress" value={progress} max={1} aria-label="Upload progress" />
        ) : null}
        <p role="status" aria-live="polite" className="muted">
          {status}
        </p>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            {savedEventId
              ? 'Retry upload'
              : pages.length
                ? `Save letter (${pages.length} page${pages.length === 1 ? '' : 's'})`
                : 'Save without pages'}
          </button>
          <Link to="/" className="btn btn-ghost">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
