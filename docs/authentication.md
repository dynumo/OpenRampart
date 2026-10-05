# Accounts and sign-in

## Registration

The registration mode is set by `REGISTRATION_MODE`. An administrator can override it under
**Settings → System settings**.

| Mode         | Behaviour                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first-user` | Default. Only the first account can self-register, and it becomes the administrator. After that, people join by Helper invitation, or an operator creates accounts with the CLI. |
| `open`       | Anyone who can reach the site can create an account, and with it their own record.                                                                                               |
| `closed`     | No self-registration. Invitation links still work.                                                                                                                               |

Sign-in accepts either the username or the email address. Email is optional unless password
reset by email is wanted.

## Passwords

- Passwords are hashed with **argon2id** using the OWASP-recommended parameters (19 MiB
  memory, 2 iterations, parallelism 1).
- A password must be between 12 and 256 characters. Passphrases are encouraged. Very common
  passwords, repeated characters and passwords containing the username or email are refused.
- When an account does not exist, a dummy hash is still verified, so response times do not
  reveal whether an account exists.
- Changing a password requires the current password and signs out every other session.

## Two-step sign-in (TOTP)

With `REQUIRE_TOTP=true` (the default), every account must enrol an authenticator app before
it can use the application.

- Codes are standard RFC 6238 codes: SHA-1, 6 digits, 30-second step, with one step of clock
  tolerance either side.
- A code cannot be used twice. The last accepted time step is stored, and any code at or
  before it is refused.
- TOTP secrets are encrypted at rest with AES-256-GCM using `ENCRYPTION_KEY`.
- Re-enrolling a new app requires a current code and signs out other sessions.

## Recovery codes

- Ten single-use codes are shown once at enrolment and can be regenerated later. Regenerating
  invalidates the old set.
- Only an HMAC of each code is stored. A code is consumed atomically, so it cannot be used
  twice, even by two requests at the same moment.
- Using a recovery code is recorded in the Audit Log, and the security page shows how many
  codes remain.
- An operator can reset a person's TOTP with `node dist/server/cli.js reset-totp <username>`.
  The person then enrols again at their next sign-in.

## Sessions

- After a successful password check, the server creates a session row in PostgreSQL. The
  browser only receives a random 256-bit token in an `HttpOnly` cookie. The database stores a
  keyed hash (HMAC with `SESSION_SECRET`), so a database leak does not give usable sessions.
- Cookie: `__Host-or_session` (`Secure`, `Path=/`, no `Domain`) when served over HTTPS,
  otherwise `or_session`. `SameSite=Lax`.
- Session stages:
  - `mfa`: password accepted, code required;
  - `totp_setup`: must enrol before continuing;
  - `active`: fully signed in.

  Only `active` sessions can reach the record.

- Sessions expire after `SESSION_MAX_AGE_HOURS` (14 days by default), or after
  `SESSION_IDLE_TIMEOUT_MINUTES` without use (3 days by default).
- **Settings → Security** lists active sessions with device and approximate time. Any of them
  can be signed out.
- All sessions are revoked when the password is changed or reset, when TOTP is reset, or when
  an administrator disables the account.

## CSRF

State-changing API requests must:

1. carry the `X-CSRF-Token` header, matching the token bound to the session; and
2. come from the application's own origin. The `Origin` header is checked when present, and
   `Sec-Fetch-Site: cross-site` is refused.

Together with `SameSite=Lax` cookies, this blocks cross-site form posts and fetches. The
OAuth token endpoint and `/mcp` use bearer tokens, not cookies, so CSRF does not apply to them.

## Rate limiting

Limits are stored in PostgreSQL, so they hold across restarts and replicas.

| Limiter         | Key               | Allowance                              | Block after exceeding                 |
| --------------- | ----------------- | -------------------------------------- | ------------------------------------- |
| `loginIp`       | IP address        | 30 attempts / 15 minutes               | 15 minutes                            |
| `loginAccount`  | username or email | 10 failed passwords / hour             | 30 minutes (audited as `auth.locked`) |
| `mfa`           | account           | 6 codes / 15 minutes                   | 15 minutes                            |
| `register`      | IP address        | 10 / hour                              | —                                     |
| `invitation`    | IP address        | 30 / hour                              | —                                     |
| `passwordReset` | IP address        | 5 / hour                               | —                                     |
| `sensitive`     | account           | 10 password confirmations / 15 minutes | 15 minutes                            |
| `oauthToken`    | IP address        | 120 / minute                           | —                                     |

Behind a reverse proxy, set `TRUST_PROXY` so the real client IP is used.

## Password reset

Password reset by email is available only when a mail provider is configured and the account
has an email address.

1. The request always gets the same response, whether or not the account exists.
2. The reset link holds a random token. Only its HMAC is stored, and it is valid for one hour
   and one use.
3. Completing a reset signs out all sessions. **It does not bypass two-step sign-in**: the
   person still needs their authenticator app or a recovery code.

Without email, or if someone loses access to their email, the operator can set a new password
from the command line. This signs out every session, but two-step sign-in still applies:

```sh
docker compose exec -e OPENRAMPART_PASSWORD='a new long passphrase' app \
  node dist/server/cli.js reset-password <username>
```

If they have also lost their authenticator app and recovery codes, the operator can reset
two-step sign-in so they enrol again:

```sh
docker compose exec app node dist/server/cli.js reset-totp <username>
```

Confirm the person's identity outside OpenRampart before doing either. Both actions are
recorded in that person's Audit Log. Setting another person's password is deliberately not
available in the web interface.

## Administrator actions

Administrators can disable and enable accounts and reset another person's TOTP. They cannot
read anyone's record. These actions are written to the affected person's Audit Log as
`admin.action`.

## Audit

Sign-ins, failures, lock-outs, recovery-code use, password changes, session revocations,
sharing changes, exports and OAuth grants are written to the Audit Log. It is shown under
**Settings → Security → Audit Log** and kept separate from the timeline. An Audit Log entry
can be copied into the timeline as an Event. This is a deliberate manual action, for example
"Unknown sign-in attempt".
