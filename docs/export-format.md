# Export format (`openrampart.export.v1`)

An export is a ZIP archive of ordinary files: JSON, Markdown, plain text and the original
documents exactly as uploaded. You do not need OpenRampart to read it, and it is designed to be
handed to an adviser, solicitor, ombudsman or court bundle preparer.

Ways to produce one:

- **Web:** Settings → Export your data.
- **API:** `GET /api/export`.
- **MCP:** `export_record`. This returns the same data as JSON, without original files.

An owner's export is complete. A Helper with the Export capability gets only what their
export-capable grants cover, with the same redaction rules as on screen (see
[authorisation.md](authorisation.md)). The export itself is recorded in the Audit Log.

Deleted items (in the Trash) are not included.

## Layout

```
openrampart-export-2026-10-05.zip
├── README.md                      human-readable guide to the archive
├── manifest.json                  metadata and counts
├── events.json                    Events, oldest first
├── actors.json                    Actors
├── incidents.json                 Incidents and their Event ids
├── relations.json                 links between related Events
├── revisions.json                 Event revision history (owner exports only)
├── attachments.json               attachment metadata, hashes and OCR text
├── timeline.md                    readable timeline
├── timestamps/
│   └── <subjectType>_<id>.ots     OpenTimestamps proofs
└── attachments/
    ├── events/<YYYY-MM-DD>_<eventId>/
    │   ├── 01_<id8>_<filename>             original file, byte-for-byte
    │   └── 01_<id8>_<filename>.ocr.txt     recognised or corrected text
    └── incidents/<incidentId>/...
```

Original files and `.ocr.txt` files are included when the exporting context may read
attachment contents. This is always true in the web interface. Over MCP it requires
`attachments:read`. Otherwise `attachments.json` still lists names, sizes and hashes.

All timestamps are ISO 8601 in UTC. All ids are UUIDs.

## `manifest.json`

```json
{
  "schema": "openrampart.export.v1",
  "exportedAt": "2026-10-05T09:12:44.120Z",
  "recordOwner": "Alex Example",
  "recordOwnerId": "…",
  "exportedBy": "…",
  "scope": "complete",
  "timezone": "Europe/London",
  "counts": {
    "events": 214,
    "actors": 31,
    "incidents": 4,
    "relations": 12,
    "revisions": 340,
    "attachments": 96,
    "timestampProofs": 436
  },
  "attachmentContentsIncluded": true,
  "notes": []
}
```

- `scope` is `complete` (owner) or `helper` (partial).
- `timezone` is the owner's time zone, used for date-only Events and in `timeline.md`.

## `events.json`

An array, ordered by `occurredAt` then `id`:

| Field                    | Type                                          | Notes                                                                   |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                     | uuid                                          |                                                                         |
| `title`                  | string \| null                                | As entered (may be empty)                                               |
| `displayTitle`           | string                                        | Title, or a generated one such as "Letter from DWP"                     |
| `type`                   | string                                        | Type key, e.g. `letter_in`, `phone_call`                                |
| `typeLabel`              | string                                        | Human label at the time of export                                       |
| `occurredAt`             | ISO date-time                                 | For `date` precision: midnight in the owner's time zone, as UTC         |
| `occurredPrecision`      | `"date"` \| `"datetime"`                      |                                                                         |
| `endedAt`                | ISO date-time \| null                         | For calls, visits and other periods                                     |
| `recordedAt`             | ISO date-time                                 | When it was first recorded                                              |
| `direction`              | `inbound` \| `outbound` \| `internal` \| null |                                                                         |
| `description`            | string                                        | Notes (plain text)                                                      |
| `tags`                   | string[]                                      |                                                                         |
| `riskLevel`              | `none` \| `low` \| `medium` \| `high`         |                                                                         |
| `riskNote`               | string \| null                                |                                                                         |
| `amount`                 | decimal string \| null                        | e.g. `"1234.56"`                                                        |
| `currency`               | ISO 4217 \| null                              |                                                                         |
| `reference`              | string \| null                                | Their reference number                                                  |
| `dueOn`                  | `YYYY-MM-DD` \| null                          | Deadline                                                                |
| `actors`                 | array                                         | `{ "id", "name", "role" }`, or `{ "redacted": true }` in Helper exports |
| `incidentIds`            | uuid[]                                        |                                                                         |
| `revision`               | integer                                       | Current revision number                                                 |
| `createdAt`, `updatedAt` | ISO date-time                                 |                                                                         |
| `createdBy`              | `{ "id", "displayName" }` \| null             | Who recorded it                                                         |
| `createdVia`             | `web` \| `mcp`                                | `mcp` = through a connected application                                 |

## `actors.json`

`id`, `name`, `kind` (`organisation`, `person` or `other`), `aliases`, `description`,
`accountReference`, `website`, `email`, `phone`, `address`, `archivedAt`, `mergedIntoId` and
`createdAt`.

In Helper exports, details of Actors the Helper can only see by name are blank. Actors merged
into another have `mergedIntoId` set.

## `incidents.json`

`id`, `title`, `description`, `status` (`open`, `monitoring`, `resolved` or `closed`), `openedOn`,
`closedOn`, `impactSummary`, `outcomeNotes`, `createdAt` and `eventIds` (visible Events, in
date order).

## `relations.json`

`id`, `eventA`, `eventB`, `note` and `createdAt`. Relations are undirected.

## `revisions.json` (owner exports only)

One row per Event revision, ordered by Event then revision number:

| Field                                  | Notes                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `eventId`, `revision`                  |                                                                                                           |
| `changeKind`                           | `create`, `update`, `delete` or `restore`                                                                 |
| `changedFields`                        | Names of the fields that changed (`attachments` when files were added or removed, `actors` after a merge) |
| `canonical`                            | The full Event snapshot as **RFC 8785 canonical JSON** (a string)                                         |
| `sha256`                               | SHA-256 of `canonical` (UTF-8), hex                                                                       |
| `previousSha256`                       | `sha256` of the previous revision (null for revision 1)                                                   |
| `createdAt`, `createdBy`, `createdVia` |                                                                                                           |

To verify a chain:

```sh
jq -r '.[] | select(.eventId=="<id>") | .canonical' revisions.json   # one snapshot per line
python3 - <<'PY'
import json, hashlib
revs = [r for r in json.load(open("revisions.json")) if r["eventId"] == "<id>"]
prev = None
for r in revs:
    assert hashlib.sha256(r["canonical"].encode()).hexdigest() == r["sha256"]
    assert r["previousSha256"] == prev
    prev = r["sha256"]
print("chain OK")
PY
```

Snapshots can contain Actor names outside a Helper's scope, so Helper exports omit this file's
contents (an empty array).

## `attachments.json`

| Field                    | Notes                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| `id`                     |                                                                    |
| `eventId` / `incidentId` | One of the two is set                                              |
| `originalFilename`       | As uploaded (sanitised)                                            |
| `mimeType`               | Detected from content                                              |
| `sizeBytes`              |                                                                    |
| `sha256`                 | Hex SHA-256 of the original bytes                                  |
| `uploadedAt`             |                                                                    |
| `ocrText`                | Machine-recognised text (null without content access)              |
| `ocrCorrectedText`       | Your corrections, if any. The original OCR text is kept separately |
| `ocrEngine`              | e.g. `ocrmypdf 14.0.1 + tesseract 5.3.0`, or `pdftotext 22.12.0`   |
| `path`                   | Location of the original inside the ZIP                            |

Check a file:

```sh
sha256sum "attachments/events/2026-09-12_<eventId>/01_ab12cd34_letter.pdf"
```

## `timestamps/*.ots`

These are standard [OpenTimestamps](https://opentimestamps.org) proof files.

- Files named `attachment_<id>.ots` commit to an attachment's SHA-256.
- Files named `event_revision_<id>.ots` commit to a revision's `sha256`.

Proofs that are still pending contain calendar commitments only. Complete proofs contain a
Bitcoin attestation.

```sh
ots verify -d <sha256-hex> timestamps/attachment_<id>.ots
```

A verified proof shows the hash existed no later than the attested block time. See
[timestamping.md](timestamping.md).

## `timeline.md`

A plain Markdown rendering of every Event, oldest first. Each entry has its date in the
owner's time zone, title, type, Actors, risk level and notes. It is meant for printing or
pasting into a letter.

## Compatibility

- New optional fields may be added within `v1`. Readers should ignore unknown fields.
- Renaming or removing fields, or changing their meaning, will change `schema` to
  `openrampart.export.v2`, documented here.
