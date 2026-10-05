# MCP server

OpenRampart exposes a remote [Model Context Protocol](https://modelcontextprotocol.io) server.
It lets an AI assistant of your choice search, read and (if you allow it) add to your record.
It is entirely optional: OpenRampart never calls an AI service itself.

- **Endpoint:** `https://<your APP_URL>/mcp`
- **Transport:** Streamable HTTP, stateless, JSON responses. Both the 2025 protocol revisions
  and the 2026-07-28 revision are supported.
- **Authorisation:** OAuth 2.1 bearer tokens issued by OpenRampart's own authorisation server.
  See [oauth.md](oauth.md).

## Connecting a client

Most MCP clients only need the server URL. They discover everything else from the `401`
challenge and the metadata documents.

1. Add a remote MCP server in your client with the URL `https://rampart.example.org/mcp`.
2. Your browser opens OpenRampart. Sign in, choose which record to connect, tick only the
   permissions you want, and select **Allow access**.
3. The connection appears under **Settings → MCP Connections**, where you can revoke it at
   any time.

Good practice:

- Start with read-only access.
- Grant **Read attachment contents** only if you are comfortable with the assistant (and its
  provider) reading your documents.
- Grant write scopes only to assistants you trust to act carefully.

## Tools

Every tool runs through the same domain layer as the web interface. Results contain only what
the connected person can see, with Helper redaction applied. A tool called without its
required scope returns `403 insufficient_scope`, naming the missing scope.

### Reading

| Tool                      | Scopes                                | What it returns                                                                                                                         |
| ------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `search_events`           | `events:read`, `search:read`          | Ranked Events with snippets; filters for Actor, type, Incident, dates, risk, attachments                                                |
| `get_event`               | `events:read`                         | One Event with Actors, Incidents, related Events, attachment summaries, revision count                                                  |
| `list_event_types`        | `events:read`                         | Built-in and custom Event types                                                                                                         |
| `list_actors`             | `actors:read`                         | Actors (filter by name; include archived)                                                                                               |
| `get_actor`               | `actors:read`                         | One Actor with details (if fully accessible)                                                                                            |
| `get_actor_timeline`      | `actors:read`, `events:read`          | Events involving an Actor, with the same filters as the timeline                                                                        |
| `list_incidents`          | `incidents:read`                      | Incidents with status and dates                                                                                                         |
| `get_incident`            | `incidents:read`                      | One Incident                                                                                                                            |
| `get_incident_timeline`   | `incidents:read`, `events:read`       | The Incident's Events in order                                                                                                          |
| `search_documents`        | `search:read`, `attachments:metadata` | Attachments matching a query. With `attachments:read` this searches OCR text and returns snippets; otherwise filenames only and no text |
| `get_attachment_metadata` | `attachments:metadata`                | File name, type, size, SHA-256, OCR and timestamp status: no contents                                                                   |
| `get_attachment`          | `attachments:read`                    | OCR or extracted text, and the original file (up to 8 MB) as an embedded resource                                                       |
| `export_record`           | `export:read`                         | Structured JSON export of the accessible record (no original files; OCR text only with `attachments:read`)                              |

### Writing

| Tool                         | Scopes              | What it does                                                                            |
| ---------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `create_event`               | `events:write`      | Records a new Event, optionally linking existing Actors or creating new ones            |
| `update_event`               | `events:write`      | Updates fields of an Event (creates a revision)                                         |
| `link_events`                | `events:write`      | Marks two Events as related (owner only)                                                |
| `create_actor`               | `actors:write`      | Creates an Actor                                                                        |
| `update_actor`               | `actors:write`      | Updates an Actor                                                                        |
| `create_incident`            | `incidents:write`   | Creates an Incident                                                                     |
| `update_incident`            | `incidents:write`   | Updates an Incident                                                                     |
| `add_event_to_incident`      | `incidents:write`   | Adds Events to an Incident                                                              |
| `remove_event_from_incident` | `incidents:write`   | Removes an Event from an Incident (owner only)                                          |
| `attach_file`                | `attachments:write` | Uploads a file (base64) to an Event; it is hashed, stored and processed like any upload |

There are no delete tools. Deleting, restoring, merging Actors and changing sharing are only
possible in the web interface.

Everything created or changed over MCP is attributed to the connected person and marked
"through a connected application" in the Event and its revision history. Tool calls appear in
the Audit Log as `mcp.access`, with the client's identity, never as Events.

## Dates

Tools accept dates as `YYYY-MM-DD` (a whole day) or ISO 8601 date-times. Date-times without an
offset are interpreted in the record owner's time zone. Results include `occurredAt` (UTC) and
`occurredPrecision` (`date` or `datetime`).

## Errors

- **Unknown or inaccessible ids** return a tool error saying the item was not found. The same
  answer is given whether the item does not exist or simply is not shared, so nothing leaks.
- **Validation problems** return a tool error listing each field.
- **Missing scopes** return HTTP `403` with a `WWW-Authenticate` challenge, so clients can
  request step-up consent.

## Prompting tips

Tool descriptions ask assistants to:

- only create or change entries when the person asks;
- prefer existing Actors to creating duplicates;
- leave unknown fields empty rather than guessing.

You remain responsible for what an assistant writes. Every change can be reviewed in the
revision history.

## Running behind a proxy or on a subpath

The MCP endpoint must be reachable at `MCP_RESOURCE_URL` (default `APP_URL/mcp`). The
`Authorization` header must reach the app unchanged. CORS on `/mcp` allows any origin, because
access is controlled by bearer tokens, not cookies.
