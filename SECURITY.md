# Security policy

OpenRampart stores sensitive personal records. We take security reports seriously and are
grateful for responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/dynumo/OpenRampart/security/advisories/new)
(Security → Report a vulnerability).

Please include:

- what you found and its impact, for example "a Helper with an Actor-scoped grant can read
  OCR text of other Actors' letters";
- steps to reproduce, ideally against a local `docker compose` installation;
- the version or commit;
- whether you would like to be credited.

What to expect:

- acknowledgement within **5 working days**;
- an initial assessment within **10 working days**;
- a fix, advisory and credit (if you wish) as soon as practical. Critical issues affecting
  confidentiality of records are prioritised above everything else.

## Scope

In scope:

- authorisation bypass or data leakage between records, or beyond a Helper's grants, including
  through search, counts, suggestions, exports or MCP;
- authentication weaknesses (sessions, TOTP, recovery codes, rate limiting, password reset);
- OAuth/MCP issues (token audience, scope enforcement, redirect handling, consent bypass);
- stored XSS, CSRF, SSRF, path traversal, injection;
- weaknesses in upload handling or document processing;
- secrets or record contents appearing in logs;
- integrity issues (revision chain, hash verification, timestamp proof handling).

Out of scope:

- attacks that need control of the server, database, bucket or `.env`;
- denial of service through traffic volume;
- missing security headers that have no demonstrable impact;
- vulnerabilities in dependencies without a demonstrated impact on OpenRampart (please still
  tell us; we will update);
- social engineering of project maintainers.

## Supported versions

Security fixes are made to the latest release on `main`. Self-hosters should keep up to date
(see [docs/docker.md](docs/docker.md)).

## Hardening guidance for operators

See [docs/security-model.md](docs/security-model.md), especially "What the operator is
responsible for".
