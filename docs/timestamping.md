# Integrity and timestamping

OpenRampart keeps three kinds of integrity evidence. Together they let you show, calmly and
precisely, that a record has not been quietly changed.

## 1. File hashes (always on)

Every uploaded file's **SHA-256** is computed while it streams in. It is stored with the
attachment and shown on the attachment page. The background worker then re-reads the stored
object and confirms the hash matches. **Verify now** on any attachment repeats that check on
demand. Original files are never modified: previews and OCR text are stored separately.

Anyone can check a file from an export:

```sh
sha256sum letter.pdf
```

## 2. Revision history (always on)

Every change to an Event appends a **revision**. This includes creating, editing, deleting,
restoring, adding or removing attachments, and Actor merges.

- The revision stores a snapshot of the whole Event as
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON. That is a deterministic
  serialisation, so anyone can re-compute the same bytes.
- `sha256` is the hash of that snapshot.
- `previousSha256` is the hash of the revision before, forming a chain. Altering or removing a
  past revision would break every later link.
- The database refuses `UPDATE` and `DELETE` on revisions (a trigger), so history cannot be
  rewritten through the application or by accident.

The Event page shows each revision, who made it and through which channel, and what changed.
The owner can view the canonical snapshot and its hash.

## 3. External timestamps (optional): OpenTimestamps

With `TIMESTAMP_PROVIDER=opentimestamps`, attachment hashes and revision hashes are timestamped
using [OpenTimestamps](https://opentimestamps.org). The proofs are anchored in the Bitcoin
blockchain. They let a third party confirm that a hash existed **no later than** a certain
time, without trusting you or the server.

### What is sent

Only hashes leave the server, and they are disguised:

1. Pending hashes are collected for `OTS_BATCH_INTERVAL_MINUTES`.
2. Each is combined with a random 128-bit nonce and hashed. Then all are combined in a Merkle
   tree, exactly as the official `ots stamp` client does.
3. Only the tree's **root** is sent to the calendar servers (`OTS_CALENDARS`). At least
   `OTS_MIN_CALENDARS` must accept it.

A calendar learns nothing about any document, or even how many there were. Each item gets its
own proof, containing only the path from its hash to the root.

### Becoming complete

Calendars aggregate submissions and commit them to a Bitcoin transaction. This usually
completes within a few hours. Every `OTS_UPGRADE_INTERVAL_MINUTES`, OpenRampart asks the
calendars (only those on the configured list) for the completed path. It then checks the
block header with an Esplora API (`BITCOIN_EXPLORER_URL`) before marking a proof complete.

| Shown as                                                 | Meaning                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Timestamp pending (usually completes within a few hours) | Waiting for the next batch, or accepted by calendars and waiting for a Bitcoin block                   |
| Timestamp verified: existed by _date and time_           | Anchored in a Bitcoin block whose header was checked; the hash existed no later than that block's time |
| Timestamp could not be completed                         | Submission or upgrade failed; it is retried by the worker                                              |
| Not timestamped                                          | Timestamping is turned off, or the item predates it                                                    |

### Verifying independently

Download the `.ots` file from the attachment page, or find it in an export under
`timestamps/`. Then:

```sh
pip install opentimestamps-client
ots verify -d <sha256-hex> attachment_<id>.ots
```

or use the drag-and-drop verifier on opentimestamps.org.

## What this does and does not show

A complete timestamp shows that **these exact bytes** (or this exact revision of an Event)
existed **no later than** the attested time.

It does **not** show:

- that what a document says is true;
- who wrote it, or that it was sent or received;
- that nothing else existed;
- anything about events before the record was made.

OpenRampart's wording reflects this, with phrases such as "the original is unchanged" and
"existed no later than". It never claims proof of truth.

## Other providers

Timestamping sits behind a `TimestampProvider` interface (`src/server/integrity/timestamping.ts`)
with `stampBatch`, `upgrade` and `verify`. An RFC 3161 time-stamping authority, or another
anchoring service, can be added without touching the rest of the application. Proofs are
stored per item in the `timestamp_proofs` table, along with the provider's name.

## Implementation notes

- The `.ots` serialisation, operations, calendar protocol and Merkle batching are implemented
  in `src/server/integrity/ots.ts`. They are tested against the official example proofs
  (`tests/fixtures/ots/`), including verifying a real Bitcoin attestation (block 358391).
- Calendar responses are size-limited and parsed defensively. Upgrade requests only go to
  calendars on the configured list, never to URLs found inside a proof.
