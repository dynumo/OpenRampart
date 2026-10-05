import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../lib/api';

export interface PickedActor {
  actorId?: string;
  name: string;
  kind?: 'organisation' | 'person' | 'other';
  role?: string | null;
  isNew?: boolean;
}

/**
 * Choose Actors for an Event. A plain text box filters existing Actors, shown
 * as a list of buttons; chosen Actors appear as removable chips. Creating a new
 * Actor is a clearly labelled button. No custom ARIA combobox is needed.
 */
export function ActorPicker(props: {
  value: PickedActor[];
  onChange: (v: PickedActor[]) => void;
  label?: string;
  hint?: string;
  allowCreate?: boolean;
  showRoles?: boolean;
}) {
  const [q, setQ] = useState('');
  const id = useId();
  const suggestions = useQuery({
    queryKey: ['actor-suggest', q],
    queryFn: () =>
      api<{ items: { id: string; name: string; kind: string; matched_alias: string | null }[] }>(
        '/actors/suggest',
        { query: { q } },
      ),
    staleTime: 10_000,
  });
  const chosenIds = new Set(props.value.map((a) => a.actorId).filter(Boolean));
  const options = (suggestions.data?.items ?? []).filter((s) => !chosenIds.has(s.id)).slice(0, 8);
  const exact =
    options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase()) ||
    props.value.some((v) => v.name.toLowerCase() === q.trim().toLowerCase());
  const add = (a: PickedActor) => {
    props.onChange([...props.value, a]);
    setQ('');
    document.getElementById(`${id}-input`)?.focus();
  };
  return (
    <div className="field">
      <label htmlFor={`${id}-input`}>{props.label ?? 'Actors'}</label>
      <span className="hint" id={`${id}-hint`}>
        {props.hint ?? 'The organisations or people involved. Type to find one, or add a new one.'}
      </span>
      {props.value.length ? (
        <ul className="chips" aria-label="Chosen Actors">
          {props.value.map((a, i) => (
            <li className="chip" key={`${a.actorId ?? a.name}-${i}`}>
              <span>
                {a.name}
                {a.isNew ? <span className="small"> (new)</span> : null}
              </span>
              {props.showRoles ? (
                <label className="visually-hidden" htmlFor={`${id}-role-${i}`}>
                  Role of {a.name}
                </label>
              ) : null}
              {props.showRoles ? (
                <input
                  id={`${id}-role-${i}`}
                  type="text"
                  placeholder="role (optional)"
                  value={a.role ?? ''}
                  onChange={(e) =>
                    props.onChange(
                      props.value.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)),
                    )
                  }
                  style={{ width: '9rem', minHeight: '2.25rem', padding: '0.2rem 0.5rem' }}
                />
              ) : null}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => props.onChange(props.value.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={`${id}-input`}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-describedby={`${id}-hint ${id}-count`}
        autoComplete="off"
      />
      <span id={`${id}-count`} className="visually-hidden" aria-live="polite">
        {q ? `${options.length} matching Actor${options.length === 1 ? '' : 's'}` : ''}
      </span>
      {q || options.length ? (
        <ul className="option-list" aria-label="Matching Actors">
          {options.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => add({ actorId: o.id, name: o.name })}>
                Add {o.name}
                {o.matched_alias ? (
                  <span className="muted small"> (also known as {o.matched_alias})</span>
                ) : null}
              </button>
            </li>
          ))}
          {props.allowCreate !== false && q.trim() && !exact ? (
            <li>
              <button
                type="button"
                onClick={() => add({ name: q.trim(), kind: 'organisation', isNew: true })}
              >
                Create new Actor “{q.trim()}”
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export function toActorPayload(list: PickedActor[]) {
  return {
    actors: list
      .filter((a) => a.actorId)
      .map((a) => ({ actorId: a.actorId!, role: a.role || null })),
    newActors: list
      .filter((a) => !a.actorId)
      .map((a) => ({ name: a.name, kind: a.kind ?? 'organisation', role: a.role || null })),
  };
}
