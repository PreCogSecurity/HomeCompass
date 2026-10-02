# HomeCompass

Know what you own, and where it is.

HomeCompass is a small web application for tracking household inventory: the
things in your cupboards, what they are worth, which room they live in, and when
you bought them. It is built for a home server, a small NAS, or a single laptop
that you actually control.

It is also a security product at heart. HomeCompass runs on **zero third-party
dependencies** — runtime and dev — using only the Node.js standard library. The
entire supply chain you inherit is Node itself.

---

## Table of contents

- [Why zero dependencies](#why-zero-dependencies)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Run](#run)
- [Test](#test)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [HTTP API](#http-api)
- [Security model](#security-model)
- [Docker](#docker)
- [Project layout](#project-layout)
- [Contributing](#contributing)
- [License](#license)

---

## Why zero dependencies

Every npm package you install is code you have to trust, patch, and audit. For a
service holding a record of everything you own, that surface is worth minimising.

| Concern            | What HomeCompass does                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Supply chain       | `package-lock.json` has no packages. There is nothing to compromise.                      |
| Install time       | `npm ci` is instant and works offline; it never contacts a registry.                      |
| Known CVEs         | `npm audit` reports 0 findings because there is no dependency tree.                       |
| Linting            | `scripts/lint.mjs` is a purpose-built linter, so ESLint is not needed either.             |
| Test runner        | `node:test` from the standard library, so Jest/Mocha are not needed.                      |
| Validation         | `src/lib/validate.js` is a small schema engine, so Zod is not needed.                     |

If you later need a capability that genuinely requires a package, please read
[CONTRIBUTING.md](CONTRIBUTING.md) first — the trade-off has to be made
explicitly, in the open.

## Prerequisites

- **Node.js >= 20.12** (see [`.nvmrc`](.nvmrc); CI also tests 22 and 24)
- npm 10 or newer (ships with Node)
- Nothing else. No database server, no build step, no compiler.

Check your version:

```bash
node --version   # must print v20.12.0 or newer
```

## Install

```bash
git clone https://github.com/PreCogSecurity/HomeCompass.git
cd HomeCompass
npm ci
```

`npm ci` installs strictly from the committed lockfile. There are no packages to
fetch, so this completes in about a second.

Optional: copy the example configuration and edit it.

```bash
cp .env.example .env
```

## Run

```bash
npm start          # production-style start
npm run dev        # same, with --watch for automatic restarts
```

Then open <http://127.0.0.1:8080>.

The server binds to `127.0.0.1` by default, so it is reachable only from the
machine it runs on. To reach it from another device, run it behind a TLS
terminating reverse proxy and set `HOST=0.0.0.0` plus `TRUST_PROXY=true`.

Inventory is persisted to `data/items.json`. Writes are atomic, so an
interrupted write can never truncate the database.

## Test

```bash
npm test           # full suite
npm run lint       # lint and security rules
npm run check      # both, in the order CI runs them
```

The suite covers the security boundaries directly: path traversal, symlink
escapes, prototype pollution, mass assignment, body-size limits, rate limiting,
DNS rebinding, header spoofing, log redaction, and concurrent-write durability.

Expected output:

```text
ℹ tests 211
ℹ pass 210
ℹ fail 0
ℹ skipped 1     # POSIX file-permission assertion, skipped on Windows
```

## Configuration

All configuration is environment based; a `.env` file in the project root is
loaded automatically. See [`.env.example`](.env.example). Invalid values stop
the process at boot rather than failing later at runtime.

| Variable                      | Default            | Purpose                                                        |
| ----------------------------- | ------------------ | -------------------------------------------------------------- |
| `HOST`                        | `127.0.0.1`        | Bind address. Loopback by default.                              |
| `PORT`                        | `8080`             | Bind port.                                                       |
| `NODE_ENV`                    | `development`      | `development`, `test` or `production`.                           |
| `LOG_LEVEL`                   | `info`             | `debug`, `info`, `warn`, `error`, `silent`.                      |
| `DATA_DIR`                    | `./data`           | Directory holding the inventory database.                        |
| `STORE_FILE`                  | `<DATA_DIR>/items.json` | Explicit database path.                                   |
| `PUBLIC_DIR`                  | `./public`         | Static assets served to the browser.                             |
| `MAX_ITEMS`                   | `5000`             | Hard ceiling on stored records.                                  |
| `MAX_BODY_BYTES`              | `65536`            | Maximum accepted JSON request body.                              |
| `RATE_LIMIT_CAPACITY`         | `120`              | API requests allowed per client per bucket.                      |
| `RATE_LIMIT_REFILL_PER_SECOND`| `2`                | Sustained request rate per client.                               |
| `TRUST_PROXY`                 | `false`            | Honour `X-Forwarded-*`. Only enable behind a proxy you control. |
| `ALLOWED_HOSTS`               | *(loopback + HOST)*| Extra accepted `Host` values. Set when using a real hostname.  |
| `METRICS_ENABLED`             | `false` in prod    | Expose `GET /api/metrics`. Off in production unless opted in.     |
| `SHUTDOWN_TIMEOUT_MS`         | `10000`            | Grace period before a forced exit.                               |

## Architecture

```text
Browser  ──HTTP/JSON──▶  src/app.js  ──▶  src/lib/validate.js   (boundary validation)
                              │
                              ├──▶  src/lib/rate-limit.js  (per-client throttle)
                              ├──▶  src/lib/static.js      (path-safe asset serving)
                              ├──▶  src/lib/store.js       (atomic JSON persistence)
                              └──▶  src/lib/logger.js      (redacting JSON logs)

src/index.js  = boot, signal handling, graceful shutdown
public/       = the UI: index.html + assets (no build step)
```

Requests flow through one pipeline: assign a request id, apply security headers
to the response, throttle the API, read a bounded JSON body, validate every
field against an allow-list schema, then call the store. Errors are funnelled
into a single JSON envelope so a stack trace can never reach a client.

## HTTP API

All responses are JSON. Errors share one shape:

```json
{ "error": { "code": "validation_failed", "message": "...", "requestId": "..." } }
```

| Method   | Path                 | Description                                            |
| -------- | -------------------- | ------------------------------------------------------ |
| `GET`    | `/api/health`        | Liveness and readiness. Never throttled. Discloses no inventory data. |
| `GET`    | `/api/metrics`       | Process counters. Disabled in production unless `METRICS_ENABLED`. |
| `GET`    | `/api/items`         | List, filter and paginate. Query: `q`, `room`, `category`, `limit`, `offset`. |
| `POST`   | `/api/items`         | Create. Requires a JSON body with at least `name`.     |
| `GET`    | `/api/items/:id`     | Fetch one item.                                        |
| `PATCH`  | `/api/items/:id`     | Partial update. Send `version` for optimistic locking. |
| `DELETE` | `/api/items/:id`     | Delete and return the removed record.                  |

Item fields: `name` (required, <=120), `category` (<=64), `room` (<=64),
`quantity` (1–100000), `purchaseDate` (`YYYY-MM-DD`), `value` (>=0),
`notes` (<=2000), `tags` (<=16 entries of <=32 characters). Unknown fields are
rejected, so a client can never write a field it does not own.

Example:

```bash
curl -X POST http://127.0.0.1:8080/api/items \
  -H 'Content-Type: application/json' \
  -d '{"name":"Cordless drill","room":"garage","quantity":2,"value":129.99}'
```

## Security model

What is implemented, and why:

- **Strict CSP** — `default-src 'none'` with `'self'` for scripts and styles, no
  `unsafe-inline`, no `unsafe-eval`, plus `object-src 'none'` and
  `frame-ancestors 'none'`. The UI ships no inline script or style, so none of
  these exceptions are needed.
- **No `innerHTML`** — every value from the API is rendered with `textContent`,
  so stored content cannot become executable markup. Enforced by a lint rule.
- **Input validation at every boundary** — a schema allow-list builds a new
  object from declared fields only. Unknown keys are rejected (no mass
  assignment), and `__proto__` / `constructor` / `prototype` are refused
  outright (no prototype pollution).
- **Strict JSON parsing** — impossible calendar dates such as `2026-02-31` are
  rejected instead of silently rolling over; request bodies are byte-capped and
  `Content-Type` must be `application/json`.
- **Path traversal defence** — static assets resolve through an extension
  allow-list, with segments, hidden files, null bytes, backslashes and decoded
  percent-encoding all rejected, plus a final containment check on the resolved
  path.
- **Per-client rate limiting** — an in-memory token bucket with a hard cap on
  tracked keys, so a flood of spoofed identities cannot exhaust memory.
- **Header spoofing resisted** — `X-Request-Id` is echoed only when it matches a
  strict pattern; `X-Forwarded-For` is ignored unless `TRUST_PROXY=true`.
- **DNS rebinding defence** — the `Host` header must name a host this instance
  answers for (loopback names plus `ALLOWED_HOSTS`). Because there is no
  authentication, a hostile page could otherwise point its own hostname at the
  loopback port and read the inventory as *same-origin*, which no CORS policy
  can prevent. Offending requests get `421` before any routing runs.
- **No authentication, by design and by disclosure** — anything that can reach
  the port can read and write the inventory. Bind to loopback, or front it with
  a proxy that authenticates. This is stated plainly in
  [SECURITY.md](SECURITY.md) rather than left to be discovered.
- **Liveness reveals nothing** — `/api/health` is unauthenticated and
  unthrottled, so it returns only `status`, `uptimeSeconds` and `version`.
  `/api/metrics` carries the counters and record count and is disabled in
  production unless `METRICS_ENABLED=true`.
- **Log hygiene** — secret-shaped fields are redacted and control characters are
  escaped, so an attacker cannot forge log lines or exfiltrate a token into logs.
- **Durable storage** — `write` + `fsync` + `rename` atomic writes with a
  directory flush, serialised mutations, `0600` file mode, and a refusal to
  start on a corrupt database rather than silently discarding a customer's
  inventory.

Known limitations are listed honestly in [SECURITY.md](SECURITY.md) — read it
before exposing this service beyond your own machine.

## Docker

```bash
docker compose up --build            # http://127.0.0.1:8080
# or
docker build -t homecompass:local .
docker run --rm -p 127.0.0.1:8080:8080 homecompass:local
```

The image runs as the unprivileged `node` user, ships only production files,
exposes a `/api/health` healthcheck, and keeps inventory in the
`/app/data` volume. The compose file additionally drops all capabilities, sets
`no-new-privileges`, and mounts the root filesystem read-only.

## Project layout

```text
src/
  app.js            HTTP pipeline: headers, throttling, routing, error envelope
  index.js          boot, graceful shutdown
  lib/
    config.js       environment parsing and validation
    errors.js       typed errors and the error response envelope
    headers.js      CSP and the full header set, client identity
    host.js         Host header allow-list (DNS rebinding defence)
    logger.js       structured JSON logging with redaction
    metrics.js      process counters
    rate-limit.js   bounded token-bucket limiter
    static.js       path-safe asset resolution
    store.js        atomic JSON persistence
    validate.js     schema validation engine
public/             the UI (no build step)
test/               node:test suite
scripts/lint.mjs    zero-dependency linter
lint.config.json    lint rules
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: one focused commit per
change, tests in the same commit, and no new dependency without discussion.

## License

MIT — see [LICENSE](LICENSE).
