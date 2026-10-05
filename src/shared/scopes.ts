/**
 * OAuth scopes granted to MCP clients. Shared by the server (enforcement) and
 * the web UI (consent screen and connection management).
 *
 * `attachments:read` (original file contents) is deliberately separate from
 * `attachments:metadata` and from `events:read`.
 */
export const OAUTH_SCOPES = [
  'events:read',
  'events:write',
  'incidents:read',
  'incidents:write',
  'actors:read',
  'actors:write',
  'attachments:metadata',
  'attachments:read',
  'attachments:write',
  'search:read',
  'export:read',
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<OAuthScope, { label: string; detail: string }> = {
  'events:read': {
    label: 'Read Events and timelines',
    detail: 'See Events, their dates, Actors and notes.',
  },
  'events:write': {
    label: 'Add and edit Events',
    detail: 'Create Events and correct them. Every change is kept in revision history.',
  },
  'incidents:read': {
    label: 'Read Incidents',
    detail: 'See Incidents and which Events they group.',
  },
  'incidents:write': {
    label: 'Organise Incidents',
    detail: 'Create and update Incidents and add or remove Events from them.',
  },
  'actors:read': {
    label: 'Read Actors',
    detail: 'See the organisations and people in your record.',
  },
  'actors:write': {
    label: 'Add and edit Actors',
    detail: 'Create Actors and update their details.',
  },
  'attachments:metadata': {
    label: 'See attachment details',
    detail:
      'See attachment file names, types, sizes, hashes and processing status — not the contents.',
  },
  'attachments:read': {
    label: 'Read attachment contents',
    detail: 'Download original files and read their OCR text.',
  },
  'attachments:write': { label: 'Add attachments', detail: 'Upload files to Events.' },
  'search:read': {
    label: 'Search your record',
    detail: 'Run searches across Events, Actors and Incidents.',
  },
  'export:read': {
    label: 'Export data',
    detail: 'Produce a complete export of the accessible record.',
  },
};

/** Scopes that imply narrower ones. */
export const SCOPE_IMPLIES: Partial<Record<OAuthScope, OAuthScope[]>> = {
  'attachments:read': ['attachments:metadata'],
};

export function expandScopes(scopes: Iterable<string>): Set<OAuthScope> {
  const out = new Set<OAuthScope>();
  for (const s of scopes) {
    if ((OAUTH_SCOPES as readonly string[]).includes(s)) {
      out.add(s as OAuthScope);
      for (const implied of SCOPE_IMPLIES[s as OAuthScope] ?? []) out.add(implied);
    }
  }
  return out;
}
