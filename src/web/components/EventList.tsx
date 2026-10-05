import { Link } from 'react-router';
import type { EventSummaryDTO } from '../../shared/types';
import { formatWhen, highlightSegments, money, monthHeading, RISK_LABEL } from '../lib/format';
import { Icon, TYPE_ICONS } from './Icon';

export function Highlight({ snippet }: { snippet: string }) {
  return (
    <>
      {highlightSegments(snippet).map((s, i) =>
        s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>,
      )}
    </>
  );
}

export function RiskBadge({ level }: { level: string }) {
  if (level === 'none') return null;
  return (
    <span className={`badge badge-risk-${level}`}>
      <Icon name="alert" />
      {RISK_LABEL[level]}
    </span>
  );
}

export function actorNames(e: Pick<EventSummaryDTO, 'actors'>): string {
  const named = e.actors.filter((a) => !a.redacted).map((a) => (a as { name: string }).name);
  const hidden = e.actors.filter((a) => a.redacted).length;
  return [
    ...named,
    ...(hidden ? [`${hidden} other Actor${hidden > 1 ? 's' : ''} not shared with you`] : []),
  ].join(', ');
}

export function EventCard({
  event,
  tz,
  snippet,
}: {
  event: EventSummaryDTO;
  tz: string;
  snippet?: string | null;
}) {
  const datePart = formatWhen(event.occurredAt, 'date', tz);
  const timePart =
    event.occurredPrecision === 'datetime'
      ? new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: tz,
        }).format(new Date(event.occurredAt))
      : null;
  const amount = money(event.amount, event.currency);
  return (
    <li>
      <article className="event-card" aria-labelledby={`ev-${event.id}`}>
        <div className="event-card__date">
          <strong>{datePart}</strong>
          {timePart}
        </div>
        <div>
          <h3 className="event-card__title" id={`ev-${event.id}`}>
            <Link to={`/events/${event.id}`}>{event.displayTitle}</Link>
          </h3>
          <div className="event-card__meta">
            <span className="type">
              <Icon name={TYPE_ICONS[event.type.key] ?? 'file'} /> {event.type.label}
            </span>
            {event.actors.length ? <span>{actorNames(event)}</span> : null}
            {amount ? <span>{amount}</span> : null}
          </div>
          {snippet ? (
            <p className="event-card__summary">
              <Highlight snippet={snippet} />
            </p>
          ) : event.summary ? (
            <p className="event-card__summary">{event.summary}</p>
          ) : null}
          <div className="event-card__indicators">
            <RiskBadge level={event.riskLevel} />
            {event.attachmentCount ? (
              <span className="badge">
                <Icon name="paperclip" />
                {event.attachmentCount} attachment{event.attachmentCount > 1 ? 's' : ''}
              </span>
            ) : null}
            {event.incidents.map((i) => (
              <span className="badge" key={i.id}>
                <Icon name="incident" />
                Incident: {i.title}
              </span>
            ))}
            {event.dueOn ? (
              <span className="badge">
                <Icon name="clock" />
                Due{' '}
                {new Date(`${event.dueOn}T12:00:00Z`).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            ) : null}
          </div>
        </div>
      </article>
    </li>
  );
}

/** Events grouped under month headings, newest or oldest first. */
export function EventList({
  events,
  tz,
  snippets,
}: {
  events: EventSummaryDTO[];
  tz: string;
  snippets?: Record<string, string | null>;
}) {
  const groups: { month: string; items: EventSummaryDTO[] }[] = [];
  for (const e of events) {
    const m = monthHeading(e.occurredAt, tz);
    const last = groups[groups.length - 1];
    if (last && last.month === m) last.items.push(e);
    else groups.push({ month: m, items: [e] });
  }
  return (
    <div>
      {groups.map((g) => (
        <section key={g.month} aria-label={g.month}>
          <h2 className="timeline-month">{g.month}</h2>
          <ul className="timeline">
            {g.items.map((e) => (
              <EventCard key={e.id} event={e} tz={tz} snippet={snippets?.[e.id]} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
