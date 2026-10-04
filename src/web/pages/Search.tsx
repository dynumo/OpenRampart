import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { SearchResultDTO } from '../../shared/types';
import { EventCard, Highlight } from '../components/EventList';
import { PageHeader } from '../components/Layout';
import { ErrorSummary, Loading } from '../components/ui';
import { api } from '../lib/api';
import { useRecord } from '../lib/auth';
import { usePageTitle } from '../lib/hooks';

type Result = SearchResultDTO & { query: string; correctedQuery: string | null };

export function SearchPage() {
  usePageTitle('Search');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const record = useRecord();
  const tz = record.data?.timezone ?? 'Europe/London';
  useEffect(() => setDraft(q), [q]);
  const result = useQuery({ queryKey: ['search', q], queryFn: () => api<Result>('/search', { query: { q } }), enabled: q.trim().length > 0 });
  const r = result.data;
  const total = r ? r.totals.events + r.totals.actors + r.totals.incidents + r.totals.documents : 0;
  return (
    <>
      <PageHeader title="Search" lede="Search Events, Actors, Incidents and the text of your documents." />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(draft.trim() ? { q: draft.trim() } : {});
        }}
        className="row"
        style={{ alignItems: 'flex-end', marginBottom: '1rem' }}
      >
        <div className="field" style={{ flex: '1 1 20rem', marginBottom: 0 }}>
          <label htmlFor="search-q">Search for</label>
          <input id="search-q" type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Companies House login" />
        </div>
        <button className="btn btn-primary" type="submit">
          Search
        </button>
      </form>
      {result.isFetching ? <Loading label="Searching…" /> : null}
      <ErrorSummary error={result.error} />
      {r ? (
        <div role="status" aria-live="polite">
          <p>
            {total ? `${total} result${total === 1 ? '' : 's'} for “${r.query}”.` : `Nothing found for “${r.query}”.`}
            {r.correctedQuery ? ` Including results for “${r.correctedQuery}”.` : ''}
          </p>
        </div>
      ) : null}
      {r?.actors.length ? (
        <section aria-labelledby="sr-actors">
          <h2 id="sr-actors">Actors ({r.totals.actors})</h2>
          <ul className="plain-list">
            {r.actors.map((a) => (
              <li key={a.id}>
                <Link to={`/actors/${a.id}`}>{a.name}</Link>
                {a.snippet ? (
                  <div className="small">
                    <Highlight snippet={a.snippet} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r?.incidents.length ? (
        <section aria-labelledby="sr-incidents">
          <h2 id="sr-incidents">Incidents ({r.totals.incidents})</h2>
          <ul className="plain-list">
            {r.incidents.map((i) => (
              <li key={i.id}>
                <Link to={`/incidents/${i.id}`}>{i.title}</Link> <span className="muted small">({i.status})</span>
                {i.snippet ? (
                  <div className="small">
                    <Highlight snippet={i.snippet} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r?.events.length ? (
        <section aria-labelledby="sr-events">
          <h2 id="sr-events">Events ({r.totals.events})</h2>
          <ul className="timeline">
            {r.events.map((e) => (
              <EventCard key={e.id} event={e} tz={tz} snippet={e.snippet} />
            ))}
          </ul>
          {r.totals.events > r.events.length ? (
            <p>
              <Link to={`/?q=${encodeURIComponent(r.correctedQuery ?? r.query)}`}>See all {r.totals.events} matching Events on the timeline</Link>
            </p>
          ) : null}
        </section>
      ) : null}
      {r?.documents.length ? (
        <section aria-labelledby="sr-docs">
          <h2 id="sr-docs">Documents ({r.totals.documents})</h2>
          <ul className="plain-list">
            {r.documents.map((d) => (
              <li key={d.attachmentId}>
                <Link to={`/attachments/${d.attachmentId}`}>{d.filename}</Link> <span className="muted small">in {d.parentTitle}</span>
                {d.snippet ? (
                  <div className="small">
                    <Highlight snippet={d.snippet} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
