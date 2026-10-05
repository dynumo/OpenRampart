# Contributing to OpenRampart

Thank you for helping. OpenRampart exists to give individuals a careful, durable record of
their dealings with institutions. Contributions that make it more reliable, more accessible,
or easier to run are especially welcome.

## Ground rules

- **Security and privacy first.** Never weaken authorisation, add telemetry, or send data to a
  third party. Read [docs/security-model.md](docs/security-model.md) and the review checklist
  in [docs/threat-model.md](docs/threat-model.md) before changing anything that reads data.
- **Accessibility is not optional.** New screens must meet WCAG 2.2 AA and be covered by an
  axe check in the end-to-end tests.
- **Calm, plain language.** Interface text should be clear, kind and specific. Avoid alarming
  words, jargon and blame ("You entered an invalid date" becomes "Enter a date, for example
  12 9 2026").
- **British English** in the interface and documentation.
- **Report vulnerabilities privately.** See [SECURITY.md](SECURITY.md).

## Setting up

Requirements: Node.js 22.12 or newer, Docker (for PostgreSQL and S3), and optionally the OCR
tools: `tesseract-ocr`, `ocrmypdf`, `poppler-utils` and `libheif-examples` on Debian or
Ubuntu, or `brew install tesseract ocrmypdf poppler libheif` on macOS.

```sh
git clone https://github.com/dynumo/OpenRampart.git
cd OpenRampart
npm ci
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env     # then switch to the "Local development" values at the bottom
npm run dev              # http://localhost:3000 (API and Vite with hot reload)
```

With `MAIL_PROVIDER=log`, invitation and reset links are printed in the terminal.

## Checks

Run these before opening a pull request. CI runs the same checks.

```sh
npm run typecheck
npm run lint
npm run format:check      # npm run format to fix
npm run test:unit
npm run test:integration  # needs docker-compose.dev.yml running; uses database openrampart_test
npm run build && npm run test:e2e   # Playwright + axe; uses database openrampart_e2e
```

The integration tests use a real PostgreSQL database and S3 bucket. The test set-up drops and
recreates `openrampart_test` and `openrampart_e2e` on every run. It refuses to touch any
database not ending in those names.

To use an already-installed Chromium for Playwright, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium`.

## Where things go

See [docs/architecture.md](docs/architecture.md). In short:

- **Business rules** go in `src/server/domain/`, never in route handlers or MCP tools. Both
  the web API and MCP call the same functions.
- **Any new read path** must build its `WHERE` clause from the predicates in
  `src/server/domain/access.ts`, and add leakage tests to
  `tests/integration/permissions.test.ts`.
- **Schema changes** need a new SQL file in `migrations/` plus the matching Drizzle schema
  (see [docs/migrations.md](docs/migrations.md)).
- **New settings** go in `src/server/config.ts`, `.env.example` and
  [docs/configuration.md](docs/configuration.md). A test fails if `.env.example` is out of
  step.
- **New MCP tools** declare their scopes and get an entry in [docs/mcp.md](docs/mcp.md).
- **Colours** come from `design/rain-and-wind-on-rathlin.json`. Run
  `node scripts/generate-tokens.mjs` after changing it. Do not hard-code colours in CSS.

## Tests we expect

| Change                       | Tests                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| Domain logic                 | Integration test against the real database                   |
| Anything a Helper might see  | A leakage test (Helper with narrower grants must not see it) |
| Parsers, formatting, hashing | Unit test                                                    |
| A new screen or journey      | Playwright test with `expectAccessible`                      |
| Bug fix                      | A test that fails without the fix                            |

## Commits and pull requests

- Keep pull requests focused. Explain the user-facing change and any security or
  accessibility impact.
- Write clear commit messages in the imperative ("Add Actor merge preview").
- Do not commit secrets, real personal documents or real names in fixtures. Use obviously
  fictional data.
- By contributing, you agree that your contribution is licensed under the project's licence
  (see [LICENSING.md](LICENSING.md)).

## Code style

- TypeScript strict mode. Avoid `any`; validate external input with zod.
- Prettier formats; ESLint (with `jsx-a11y` strict) lints.
- Comments explain _why_, not _what_.
- Log identifiers, never contents. No notes, OCR text, tokens or passwords in logs.
