import { sql, type SQL } from 'drizzle-orm';
import type { SearchResultDTO } from '../../shared/types.js';
import {
  actorFullAccess,
  actorLinkVisible,
  actorVisible,
  attachmentVisible,
  eventVisible,
  incidentVisible,
} from './access.js';
import { hasScope, requireScopes, type AccessContext } from './context.js';
import { summariesFor, filterSql, type EventFilters } from './events.js';
import { rows } from './sqlutil.js';

/**
 * Search across Events, Actors, Incidents and attachment text, using
 * PostgreSQL full-text search plus pg_trgm for typo tolerance.
 *
 * Leak prevention: every document that can make something match is built only
 * from data the viewer may see —
 *   - an Event's searchable text includes the names of its Actors only where
 *     the Actor link is visible, and Actor aliases/notes only where the viewer
 *     has full access to that Actor;
 *   - OCR text only counts if the viewer may read attachment contents
 *     (for OAuth clients: the attachments:read scope);
 *   - attachment filenames only count with attachments:metadata;
 *   - result totals use the same predicates as the results.
 * Spelling corrections are drawn only from words in visible titles and names.
 */

export const HL_START = '⟦';
export const HL_END = '⟧';
const HEADLINE = `StartSel=${HL_START}, StopSel=${HL_END}, MaxFragments=2, MaxWords=22, MinWords=6, FragmentDelimiter=" … "`;

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

export function queryWords(q: string): string[] {
  return (q.match(WORD_RE) ?? [])
    .map((w) => w.toLowerCase().replace(/['’]/g, ''))
    .filter((w) => w.length > 0)
    .slice(0, 12);
}

/** websearch syntax (quotes, OR, -term) OR every word as a prefix. */
function tsQuery(q: string, words: string[]): SQL {
  const prefix = words.length
    ? words.map((w) => `${w.replace(/[^\p{L}\p{N}]/gu, '')}:*`).join(' & ')
    : '';
  return prefix
    ? sql`(websearch_to_tsquery('english', ${q}) || to_tsquery('english', ${prefix}))`
    : sql`websearch_to_tsquery('english', ${q})`;
}

/** Actor text that may contribute to an Event match, per visible link. */
function eventActorDoc(ctx: AccessContext): SQL {
  return sql`coalesce((
    SELECT or_tsvector_agg(CASE WHEN ${actorFullAccess(ctx, 'a')} THEN a.search_vector ELSE to_tsvector('english', a.name) END)
    FROM event_actors ea JOIN actors a ON a.id = ea.actor_id
    WHERE ea.event_id = e.id AND ${actorLinkVisible(ctx, 'ea', 'e')}
  ), ''::tsvector)`;
}

function eventAttachmentDoc(ctx: AccessContext): SQL {
  if (hasScope(ctx, 'attachments:read')) {
    return sql`coalesce((SELECT or_tsvector_agg(setweight(att.search_vector, 'D')) FROM attachments att WHERE att.event_id = e.id AND att.deleted_at IS NULL), ''::tsvector)`;
  }
  if (hasScope(ctx, 'attachments:metadata')) {
    return sql`coalesce((SELECT or_tsvector_agg(setweight(to_tsvector('simple', regexp_replace(att.original_filename, '[._-]+', ' ', 'g')), 'D')) FROM attachments att WHERE att.event_id = e.id AND att.deleted_at IS NULL), ''::tsvector)`;
  }
  return sql`''::tsvector`;
}

function eventIncidentDoc(ctx: AccessContext): SQL {
  if (!hasScope(ctx, 'incidents:read')) return sql`''::tsvector`;
  return sql`coalesce((
    SELECT or_tsvector_agg(setweight(to_tsvector('english', i.title), 'C'))
    FROM incident_events ie JOIN incidents i ON i.id = ie.incident_id
    WHERE ie.event_id = e.id AND ${incidentVisible(ctx, 'i')}
  ), ''::tsvector)`;
}

function eventDoc(ctx: AccessContext): SQL {
  return sql`(e.search_vector || ${eventActorDoc(ctx)} || ${eventAttachmentDoc(ctx)} || ${eventIncidentDoc(ctx)})`;
}

/**
 * Suggest corrections for words that match nothing, using trigram similarity
 * against words from titles and names visible to the viewer.
 */
async function correctWords(ctx: AccessContext, words: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const w of words) {
    if (w.length < 4 || /^\d+$/.test(w)) continue;
    const [hit] = await rows<{ hit: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM events e WHERE ${eventVisible(ctx, 'e')} AND ${eventDoc(ctx)} @@ to_tsquery('english', ${w + ':*'})) AS hit`);
    if (hit?.hit) continue;
    const [best] = await rows<{ word: string; sim: number }>(sql`
      WITH vocab AS (
        SELECT DISTINCT lower(w) AS word FROM (
          SELECT regexp_split_to_table(e.title, '[^[:alnum:]]+') AS w FROM events e WHERE ${eventVisible(ctx, 'e')}
          UNION ALL
          SELECT regexp_split_to_table(a.name, '[^[:alnum:]]+') FROM actors a WHERE ${actorVisible(ctx, 'a')}
          UNION ALL
          SELECT regexp_split_to_table(i.title, '[^[:alnum:]]+') FROM incidents i WHERE ${incidentVisible(ctx, 'i')}
        ) words WHERE length(w) >= 3
      )
      SELECT word, similarity(word, ${w}) AS sim FROM vocab
      WHERE word % ${w} AND word <> ${w}
      ORDER BY sim DESC, word LIMIT 1`);
    if (best && best.sim >= 0.35) out.set(w, best.word);
  }
  return out;
}

export interface SearchOptions {
  limit?: number;
  filters?: EventFilters;
  /** Which sections to search. Defaults to all permitted. */
  include?: ('events' | 'actors' | 'incidents' | 'documents')[];
  correct?: boolean;
}

export async function search(
  ctx: AccessContext,
  rawQuery: string,
  opts: SearchOptions = {},
): Promise<SearchResultDTO & { query: string; correctedQuery: string | null }> {
  requireScopes(ctx, 'search:read');
  const query = rawQuery.trim().slice(0, 300);
  const empty = {
    events: [],
    actors: [],
    incidents: [],
    documents: [],
    totals: { events: 0, actors: 0, incidents: 0, documents: 0 },
    query,
    correctedQuery: null,
  };
  let words = queryWords(query);
  if (!words.length) return empty;
  const include = new Set(opts.include ?? ['events', 'actors', 'incidents', 'documents']);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  let effective = query;
  let correctedQuery: string | null = null;
  if (opts.correct !== false && hasScope(ctx, 'events:read')) {
    const corrections = await correctWords(ctx, words);
    if (corrections.size) {
      effective = query.replace(WORD_RE, (m) => corrections.get(m.toLowerCase()) ?? m);
      correctedQuery = effective;
      words = queryWords(effective);
    }
  }
  const tsq = tsQuery(effective, words);
  const result: SearchResultDTO = { ...empty };

  if (include.has('events') && hasScope(ctx, 'events:read')) {
    // filterSql() starts with the visibility predicate for alias `e`.
    const candidates = sql`SELECT e.id, e.title, e.description, e.search_vector, e.occurred_at, ${eventDoc(ctx)} AS doc
      FROM events e WHERE ${sql.join(filterSql(ctx, opts.filters ?? {}), sql` AND `)}`;
    const matched = await rows<{
      id: string;
      rank: number;
      title_hl: string | null;
      desc_hl: string | null;
      matched_in: string[];
    }>(sql`
      WITH c AS (${candidates}),
      m AS (
        SELECT c.id, c.title, c.description, c.search_vector,
               ts_rank_cd(c.doc, ${tsq}, 32) + 0.05 * exp(-extract(epoch from now() - c.occurred_at) / 31536000.0) AS rank,
               c.occurred_at
        FROM c WHERE c.doc @@ ${tsq}
        ORDER BY rank DESC, c.occurred_at DESC
        LIMIT ${limit}
      )
      SELECT m.id, m.rank,
        CASE WHEN to_tsvector('english', m.title) @@ ${tsq} THEN ts_headline('english', m.title, ${tsq}, ${HEADLINE}) END AS title_hl,
        CASE WHEN to_tsvector('english', m.description) @@ ${tsq} THEN ts_headline('english', left(m.description, 20000), ${tsq}, ${HEADLINE}) END AS desc_hl,
        array_remove(ARRAY[
          CASE WHEN m.search_vector @@ ${tsq} THEN 'event' END,
          CASE WHEN ${eventActorDocFor(ctx, sql`m.id`)} @@ ${tsq} THEN 'actor' END,
          CASE WHEN ${eventAttachmentDocFor(ctx, sql`m.id`)} @@ ${tsq} THEN 'attachment' END
        ], NULL) AS matched_in
      FROM m ORDER BY m.rank DESC, m.occurred_at DESC`);
    const ids = matched.map((m) => m.id);
    const eventRows = ids.length
      ? await rows<Parameters<typeof summariesFor>[1][number]>(sql`
          SELECT e.id, e.owner_id, e.title, e.description, e.occurred_at, e.occurred_precision, e.ended_at, e.recorded_at,
            e.direction, e.tags, e.risk_level, e.risk_note, e.amount::text AS amount, e.currency, e.reference,
            e.due_on::text AS due_on, e.revision, e.created_by, cu.display_name AS created_by_name, e.updated_by,
            uu.display_name AS updated_by_name, e.created_via, e.created_at, e.updated_at, e.deleted_at,
            t.id AS type_id, t.key AS type_key, t.label AS type_label
          FROM events e JOIN event_types t ON t.id = e.event_type_id
          LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users uu ON uu.id = e.updated_by
          WHERE e.id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) AND ${eventVisible(ctx, 'e')}`)
      : [];
    const summaries = await summariesFor(ctx, eventRows);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    result.events = matched
      .filter((m) => byId.has(m.id))
      .map((m) => ({
        ...byId.get(m.id)!,
        snippet: m.desc_hl ?? m.title_hl ?? null,
        matchedIn: m.matched_in,
      }));
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM (${candidates}) c WHERE c.doc @@ ${tsq}`,
    );
    result.totals.events = count?.n ?? 0;
  }

  if (include.has('actors') && hasScope(ctx, 'actors:read')) {
    const actorMatch = sql`(
      (${actorFullAccess(ctx, 'a')} AND a.search_vector @@ ${tsq})
      OR to_tsvector('english', a.name) @@ ${tsq}
      OR word_similarity(${effective}, a.name) > 0.5
    )`;
    const where = sql`${actorVisible(ctx, 'a')} AND a.merged_into_id IS NULL AND ${actorMatch}`;
    const list = await rows<{
      id: string;
      name: string;
      kind: 'organisation' | 'person' | 'other';
      snippet: string | null;
    }>(sql`
      SELECT a.id, a.name, a.kind,
        CASE WHEN ${actorFullAccess(ctx, 'a')} AND to_tsvector('english', a.description) @@ ${tsq}
             THEN ts_headline('english', a.description, ${tsq}, ${HEADLINE}) END AS snippet
      FROM actors a WHERE ${where}
      ORDER BY ts_rank(a.search_vector, ${tsq}) DESC, word_similarity(${effective}, a.name) DESC, a.name
      LIMIT ${limit}`);
    result.actors = list;
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM actors a WHERE ${where}`,
    );
    result.totals.actors = count?.n ?? 0;
  }

  if (include.has('incidents') && hasScope(ctx, 'incidents:read')) {
    const where = sql`${incidentVisible(ctx, 'i')} AND (i.search_vector @@ ${tsq} OR word_similarity(${effective}, i.title) > 0.5)`;
    const list = await rows<{
      id: string;
      title: string;
      status: 'open' | 'monitoring' | 'resolved' | 'closed';
      snippet: string | null;
    }>(sql`
      SELECT i.id, i.title, i.status,
        CASE WHEN to_tsvector('english', i.description) @@ ${tsq} THEN ts_headline('english', i.description, ${tsq}, ${HEADLINE}) END AS snippet
      FROM incidents i WHERE ${where}
      ORDER BY ts_rank(i.search_vector, ${tsq}) DESC, i.opened_on DESC LIMIT ${limit}`);
    result.incidents = list;
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM incidents i WHERE ${where}`,
    );
    result.totals.incidents = count?.n ?? 0;
  }

  if (include.has('documents') && hasScope(ctx, 'attachments:metadata')) {
    const docs = await searchDocuments(ctx, effective, { limit, tsq });
    result.documents = docs.items;
    result.totals.documents = docs.total;
  }

  return { ...result, query, correctedQuery };
}

function eventActorDocFor(ctx: AccessContext, eventId: SQL): SQL {
  return sql`coalesce((
    SELECT or_tsvector_agg(CASE WHEN ${actorFullAccess(ctx, 'a')} THEN a.search_vector ELSE to_tsvector('english', a.name) END)
    FROM event_actors ea JOIN actors a ON a.id = ea.actor_id JOIN events e ON e.id = ea.event_id
    WHERE ea.event_id = ${eventId} AND ${actorLinkVisible(ctx, 'ea', 'e')}
  ), ''::tsvector)`;
}

function eventAttachmentDocFor(ctx: AccessContext, eventId: SQL): SQL {
  if (hasScope(ctx, 'attachments:read')) {
    return sql`coalesce((SELECT or_tsvector_agg(att.search_vector) FROM attachments att WHERE att.event_id = ${eventId} AND att.deleted_at IS NULL), ''::tsvector)`;
  }
  if (hasScope(ctx, 'attachments:metadata')) {
    return sql`coalesce((SELECT or_tsvector_agg(to_tsvector('simple', regexp_replace(att.original_filename, '[._-]+', ' ', 'g'))) FROM attachments att WHERE att.event_id = ${eventId} AND att.deleted_at IS NULL), ''::tsvector)`;
  }
  return sql`''::tsvector`;
}

/**
 * Search attachment text (OCR) and filenames. Without permission to read
 * contents, only filenames are searched and no text snippet is returned.
 */
export async function searchDocuments(
  ctx: AccessContext,
  query: string,
  opts: { limit?: number; tsq?: SQL } = {},
): Promise<{ items: SearchResultDTO['documents']; total: number }> {
  requireScopes(ctx, 'search:read', 'attachments:metadata');
  const words = queryWords(query);
  if (!words.length) return { items: [], total: 0 };
  const tsq = opts.tsq ?? tsQuery(query, words);
  const canRead = hasScope(ctx, 'attachments:read');
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const matchDoc = canRead
    ? sql`att.search_vector`
    : sql`to_tsvector('simple', regexp_replace(att.original_filename, '[._-]+', ' ', 'g'))`;
  const where = sql`${attachmentVisible(ctx, 'att')} AND ${matchDoc} @@ ${tsq}`;
  const list = await rows<{
    attachment_id: string;
    event_id: string | null;
    incident_id: string | null;
    filename: string;
    snippet: string | null;
    parent_title: string;
  }>(sql`
    WITH m AS (
      SELECT att.id, att.event_id, att.incident_id, att.original_filename, att.ocr_text, att.ocr_corrected_text,
             ts_rank_cd(${matchDoc}, ${tsq}) AS rank
      FROM attachments att WHERE ${where}
      ORDER BY rank DESC, att.uploaded_at DESC LIMIT ${limit}
    )
    SELECT m.id AS attachment_id, m.event_id, m.incident_id, m.original_filename AS filename,
      ${canRead ? sql`ts_headline('english', left(coalesce(m.ocr_corrected_text, m.ocr_text, ''), 100000), ${tsq}, ${HEADLINE})` : sql`NULL`} AS snippet,
      coalesce(nullif(e.title, ''), t.label, i.title, '') AS parent_title
    FROM m
    LEFT JOIN events e ON e.id = m.event_id
    LEFT JOIN event_types t ON t.id = e.event_type_id
    LEFT JOIN incidents i ON i.id = m.incident_id
    ORDER BY m.rank DESC`);
  const [count] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM attachments att WHERE ${where}`,
  );
  return {
    items: list.map((r) => ({
      attachmentId: r.attachment_id,
      eventId: r.event_id,
      incidentId: r.incident_id,
      filename: r.filename,
      snippet: r.snippet && r.snippet.includes(HL_START) ? r.snippet : canRead ? r.snippet : null,
      parentTitle: r.parent_title,
    })),
    total: count?.n ?? 0,
  };
}

/** Quick suggestions for the search box. */
export async function suggest(ctx: AccessContext, q: string) {
  requireScopes(ctx, 'search:read');
  const words = queryWords(q);
  if (!words.length) return { actors: [], incidents: [], events: [] };
  const like = '%' + q.trim().replace(/[%_\\]/g, '\\$&') + '%';
  const prefix = sql`to_tsquery('english', ${words.map((w) => `${w}:*`).join(' & ')})`;
  const actorsList = hasScope(ctx, 'actors:read')
    ? await rows<{ id: string; name: string }>(sql`
        SELECT a.id, a.name FROM actors a
        WHERE ${actorVisible(ctx, 'a')} AND a.merged_into_id IS NULL AND (a.name ILIKE ${like} OR word_similarity(${q}, a.name) > 0.5)
        ORDER BY word_similarity(${q}, a.name) DESC, a.name LIMIT 5`)
    : [];
  const incidentsList = hasScope(ctx, 'incidents:read')
    ? await rows<{ id: string; title: string }>(sql`
        SELECT i.id, i.title FROM incidents i
        WHERE ${incidentVisible(ctx, 'i')} AND (i.title ILIKE ${like} OR to_tsvector('english', i.title) @@ ${prefix})
        ORDER BY i.opened_on DESC LIMIT 5`)
    : [];
  const eventsList = hasScope(ctx, 'events:read')
    ? await rows<{ id: string; title: string; occurred_at: Date }>(sql`
        SELECT e.id, e.title, e.occurred_at FROM events e
        WHERE ${eventVisible(ctx, 'e')} AND e.title <> '' AND (e.title ILIKE ${like} OR to_tsvector('english', e.title) @@ ${prefix})
        ORDER BY e.occurred_at DESC LIMIT 5`)
    : [];
  return {
    actors: actorsList,
    incidents: incidentsList,
    events: eventsList.map((e) => ({
      id: e.id,
      title: e.title,
      occurredAt: e.occurred_at.toISOString(),
    })),
  };
}
