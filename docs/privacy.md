# Privacy

**OpenRampart contains no analytics, no telemetry, no tracking and no advertising. It never
"phones home".**

It is self-hosted software. The data belongs to the people who use it and is controlled by
whoever runs the installation. The OpenRampart project receives nothing.

## What the software does not do

- No usage analytics, crash reporting or "anonymous statistics", and no switch to turn them
  on.
- No third-party scripts, fonts, stylesheets, images or CDNs in the web interface. Everything
  is served from your own installation. The Content Security Policy blocks external resources.
- No update checks or licence checks.
- No AI services. OCR runs locally with Tesseract and suggestions are rule-based. An AI
  assistant only gets access if a person connects one through MCP and approves its
  permissions, and they can revoke it at any time.
- No tracking pixels or click tracking in emails. Elastic Email open and click tracking is
  explicitly disabled.

## What leaves the server, and when

Only these outbound connections are made, and only when configured:

| Destination                                | When                                                       | What is sent                                                                 |
| ------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Your object storage                        | Always                                                     | Original files and previews                                                  |
| Your mail provider (Elastic Email or SMTP) | `MAIL_PROVIDER` set                                        | Recipient address, subject, short message with a link. Never record contents |
| OpenTimestamps calendars                   | `TIMESTAMP_PROVIDER=opentimestamps`                        | A Merkle root of salted hashes. No content, filenames or metadata            |
| Bitcoin block explorer (Esplora API)       | Timestamping enabled                                       | Block heights, to fetch public block headers                                 |
| OAuth client metadata URLs                 | An MCP client using a Client ID Metadata Document connects | A request for that client's public metadata document                         |

Nothing else is contacted.

## What is stored

- **Account data:** username, display name, optional email address, time zone, password hash,
  encrypted TOTP secret, hashed recovery codes.
- **The record:** everything people enter or upload.
- **Security data:** sessions (with IP address and user agent, so people can recognise their
  devices), rate-limit counters and the Audit Log (with IP address and user agent).
- **Operational logs:** written to standard output for the operator. They contain request
  paths (without query strings or tokens), status codes, timings and error messages, and never
  passwords, tokens, notes or document text.

## People's control over their data

- **Export** everything at any time, in open formats (Settings → Export your data).
- **Delete** items. They go to the Trash and are purged after the retention period. Purging
  removes files from storage as well as from the database.
- **See** every session, sharing grant and connected application, and **revoke** any of them.
- **Review** the Audit Log of security-relevant activity on their account.

## For operators

If you run OpenRampart for other people, you are the data controller (or processor) for their
records. You may need your own privacy notice. The table above lists the processors involved
(your hosting, storage and mail providers). OpenRampart's design aims to make that notice short.
