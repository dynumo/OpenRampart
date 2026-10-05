import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { EventSummaryDTO, EventTypeDTO, IncidentDTO, Page } from '../../shared/types';
import { EventList } from '../components/EventList';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Layout';
import { ErrorSummary, Loading } from '../components/ui';
import { api } from '../lib/api';
import { useRecord } from '../lib/auth';
import { usePageTitle } from '../lib/hooks';

export function useEventTypes() {
  return useQuery({ queryKey: ['event-types'], queryFn: () => api<{ items: EventTypeDTO[] }>('/event-types'), staleTime: 300_000 });
}

export interface TimelineFilterState {
  actorId?: string;
  typeId?: string;
  incidentId?: string;
  from?: string;
  to?: string;
  risk?: string;
  hasAttachments?: boolean;
  q?: string;
  order?: 'asc' | 'desc';
}

export function readFilters(params: URLSearchParams): TimelineFilterState {
  return {
    actorId: params.get('actorId') ?? undefined,
    typeId: params.get('typeId') ?? undefined,
    incidentId: params.get('incidentId') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    risk: params.get('risk') ?? undefined,
    hasAttachments: params.get('hasAttachments') === 'true',
    q: params.get('q') ?? undefined,
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
}

/** Timeline filter form. Applies on submit so screen readers are not flooded with updates. */
export function TimelineFilters(props: { value: TimelineFilterState; onApply: (v: TimelineFilterState) => void; hide?: ('actor' | 'incident')[]; open?: boolean }) {
  const types = useEventTypes();
  const incidents = useQuery({ queryKey: ['incidents', 'filter'], queryFn: () => api<{ items: IncidentDTO[] }>('/incidents'), enabled: !props.hide?.includes('incident') });
  const actors = useQuery({ queryKey: ['actors', 'filter'], queryFn: () => api<{ items: { id: string; name: string }[] }>('/actors', { query: { limit: 500 } }), enabled: !props.hide?.includes('actor') });
  const [v, setV] = useState(props.value);
  const active = Object.entries(props.value).filter(([k, x]) => x && k !== 'order').length;
  return (
    <details className="filters" open={props.open || active > 0}>
      <summary>Filter{active ? ` (${active} active)` : ''}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onApply(v);
        }}
      >
        <div className="filters-grid">
          <div className="field">
            <label htmlFor="f-q">Containing words</label>
            <input id="f-q" type="search" value={v.q ?? ''} onChange={(e) => setV({ ...v, q: e.target.value || undefined })} />
          </div>
          {!props.hide?.includes('actor') ? (
            <div className="field">
              <label htmlFor="f-actor">Actor</label>
              <select id="f-actor" value={v.actorId ?? ''} onChange={(e) => setV({ ...v, actorId: e.target.value || undefined })}>
                <option value="">Any Actor</option>
                {actors.data?.items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="f-type">Event type</label>
            <select id="f-type" value={v.typeId ?? ''} onChange={(e) => setV({ ...v, typeId: e.target.value || undefined })}>
              <option value="">Any type</option>
              {types.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {!props.hide?.includes('incident') ? (
            <div className="field">
              <label htmlFor="f-incident">Incident</label>
              <select id="f-incident" value={v.incidentId ?? ''} onChange={(e) => setV({ ...v, incidentId: e.target.value || undefined })}>
                <option value="">Any or none</option>
                {incidents.data?.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="f-from">From date</label>
            <input id="f-from" type="date" value={v.from ?? ''} onChange={(e) => setV({ ...v, from: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-to">To date</label>
            <input id="f-to" type="date" value={v.to ?? ''} onChange={(e) => setV({ ...v, to: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-risk">Risk</label>
            <select id="f-risk" value={v.risk ?? ''} onChange={(e) => setV({ ...v, risk: e.target.value || undefined })}>
              <option value="">Any</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-order">Order</label>
            <select id="f-order" value={v.order ?? 'desc'} onChange={(e) => setV({ ...v, order: e.target.value as 'asc' | 'desc' })}>
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </div>
        </div>
        <div className="choice">
          <input id="f-att" type="checkbox" checked={Boolean(v.hasAttachments)} onChange={(e) => setV({ ...v, hasAttachments: e.target.checked || undefined })} />
          <label htmlFor="f-att">Only Events with attachments</label>
        </div>
        <div className="row">
          <button className="btn btn-primary" type="submit">
            Apply filters
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              const cleared: TimelineFilterState = { order: 'desc' };
              setV(cleared);
              props.onApply(cleared);
            }}
          >
            Clear
          </button>
        </div>
      </form>
    </details>
  );
}

export function useEventPages(filters: TimelineFilterState, extra: Record<string, string> = {}) {
  return useInfiniteQuery({
    queryKey: ['events', filters, extra],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<Page<EventSummaryDTO> & { correctedQuery?: string | null }>('/events', {
        query: {
          actorId: filters.actorId,
          typeId: filters.typeId,
          incidentId: filters.incidentId,
          from: filters.from,
          to: filters.to,
          risk: filters.risk,
          hasAttachments: filters.hasAttachments ? 'true' : undefined,
          q: filters.q,
          order: filters.order,
          cursor: pageParam ?? undefined,
          limit: 40,
          // Fixed context (e.g. the Actor whose timeline this is) wins over filters.
          ...extra,
        },
      }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function EventPages({ filters, extra, emptyText }: { filters: TimelineFilterState; extra?: Record<string, string>; emptyText: string }) {
  const record = useRecord();
  const q = useEventPages(filters, extra);
  const tz = record.data?.timezone ?? 'Europe/London';
  if (q.isLoading) return <Loading label="Loading Events…" />;
  if (q.error) return <ErrorSummary error={q.error} />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total;
  return (
    <>
      <p className="muted small" role="status">
        {total === undefined ? '' : `${total} Event${total === 1 ? '' : 's'}`}
        {q.data?.pages[0]?.correctedQuery ? ` — showing results for “${q.data.pages[0].correctedQuery}”` : ''}
      </p>
      {items.length ? <EventList events={items} tz={tz} /> : <div className="empty">{emptyText}</div>}
      {q.hasNextPage ? (
        <button type="button" className="btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Show more Events'}
        </button>
      ) : null}
    </>
  );
}

export function TimelinePage() {
  usePageTitle('Timeline');
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const record = useRecord();
  const apply = (f: TimelineFilterState) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v && !(k === 'order' && v === 'desc')) next.set(k, String(v));
    setParams(next);
  };
  return (
    <>
      <PageHeader
        title="Timeline"
        lede={record.data?.role === 'helper' ? `Events shared with you from ${record.data.ownerName}’s record.` : 'Everything you have recorded, most recent first.'}
        actions={
          record.data?.capabilities.add !== false ? (
            <>
              <Link className="btn btn-primary" to="/events/new">
                <Icon name="plus" />
                Add Event
              </Link>
              <Link className="btn" to="/events/new/letter">
                <Icon name="camera" />
                Capture a letter
              </Link>
            </>
          ) : null
        }
      />
      <TimelineFilters value={filters} onApply={apply} />
      <EventPages
        filters={filters}
        emptyText={Object.values(filters).some((v) => v && v !== 'desc') ? 'No Events match these filters.' : 'Nothing recorded yet. Use “Add Event” to record a letter, call, payment or anything else.'}
      />
    </>
  );
}
