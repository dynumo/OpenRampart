# Email

OpenRampart works fully without email. When a provider is configured, it sends a small number
of messages:

| Message           | When                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Helper invitation | The owner invites someone by email address                                                       |
| Password reset    | Someone asks to reset a forgotten password                                                       |
| Security notice   | Password changed, authenticator app changed, recovery code used, a Helper accepted an invitation |

Messages contain names, a short explanation and a link back to OpenRampart. **They never
contain record contents**, such as Event notes, document text or attachments. Click and open
tracking is turned off.

Without email:

- the invitation link is shown to the owner to copy and share;
- the "Forgotten your password?" link is hidden; whoever runs the installation can set a new
  password with `cli.js reset-password` (see [authentication.md](authentication.md));
- security notices are only recorded in the Audit Log.

An administrator can send a test message from **Settings → System settings**.

## Elastic Email (HTTP API) — recommended

OpenRampart has first-class support for the [Elastic Email](https://elasticemail.com) v4 HTTP
API. It uses no SMTP connection and no SDK. It sends one `POST` request to:

```
POST https://api.elasticemail.com/v4/emails/transactional
X-ElasticEmail-ApiKey: <key>
```

The request body has `Recipients.To`, `Content.From`, `Content.Subject`, a plain-text and HTML
`Body`, and `Options.TrackOpens=false` and `Options.TrackClicks=false`. Transactional sending
means messages are not treated as marketing and carry no unsubscribe footer.

### Set-up

1. Verify your sending domain in Elastic Email (SPF, DKIM and DMARC records), for example
   `rampart.example.org` or your main domain.
2. Create an **API key** under **Settings → Manage API Keys**:
   - Permission: **Custom**, with only **Send Http** enabled. Nothing else is needed.
   - Optionally restrict it to your server's IP address.
3. Configure:

```sh
MAIL_PROVIDER=elasticemail
ELASTIC_EMAIL_API_KEY=<the key>
MAIL_FROM_ADDRESS=no-reply@rampart.example.org
MAIL_FROM_NAME=OpenRampart
# ELASTIC_EMAIL_API_URL=https://api.elasticemail.com/v4   (default)
```

4. Restart and send a test email from **Settings → System settings**.

Requests time out after 15 seconds. If sending fails:

- an invitation is still created, and its link is shown to the owner to share another way;
- a password reset request gets the usual response, so failures reveal nothing about which
  accounts exist (the person can ask again or contact the operator);
- security notices do not block the action that triggered them.

Each failure is logged as a warning, with the provider's error message but never the message
content.

The API key is only ever sent in the `X-ElasticEmail-ApiKey` header to the configured API URL.
It is never logged.

## SMTP

Any SMTP service works: your mail host, Fastmail, Mailgun, Postmark, Amazon SES, Microsoft
365 and so on. Messages are sent with [Nodemailer](https://nodemailer.com).

```sh
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_SECURE=false        # STARTTLS on 587; set true for implicit TLS on 465
SMTP_USER=…
SMTP_PASSWORD=…
MAIL_FROM_ADDRESS=no-reply@rampart.example.org
MAIL_FROM_NAME=OpenRampart
```

With `SMTP_SECURE=false`, the connection is upgraded with STARTTLS when the server offers it.
Certificates are always verified.

## Development

`MAIL_PROVIDER=log` prints each message to the console instead of sending it, which makes
invitation and reset links easy to copy. It is **refused in production**, because those links
are credentials and must not end up in logs.

## Privacy

Your mail provider will see each recipient's address, the subject and the message text (names
and links, as above). Choose a provider whose data processing terms you are comfortable with.
OpenRampart sends nothing else to it.
