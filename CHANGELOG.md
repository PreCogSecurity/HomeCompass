# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **DNS rebinding defence (new).** The `Host` header is validated against an
  allow-list (loopback names, the configured `HOST`, and `ALLOWED_HOSTS`);
  anything else is refused with `421 Misdirected Request` before routing,
  storage or asset resolution runs. Shipping without authentication on a
  loopback port was otherwise directly exploitable by any web page the user
  visited, and no CORS policy could have prevented it. The rejected value is
  never reflected back.
- `/api/metrics` is now **disabled in production** by default (`404`) and is
  throttled like any other endpoint. It reveals how much the household owns, and
  it was previously an unauthenticated, unlimited-rate operational read.
- `/api/health` no longer discloses the inventory record count. It is
  unauthenticated and unthrottled, so it now returns liveness only.
- Static asset serving now verifies the **real** path after following symlinks,
  so a link inside the document root can no longer read files outside it.
- `.gitignore` now excludes `node_modules/` and `data/`. `data/items.json` is the
  customer's plaintext inventory and was previously committable.

### Reliability

- Persistence is now genuinely durable: the temp file is `fsync`ed before the
  `rename` and the parent directory is flushed afterwards. `rename` alone was
  atomic but not durable, so a power loss could still revert the only copy of the
  inventory.
- `store.list()` applies an explicit `id` tie-break, making page order total and
  reproducible instead of relying on the engine's sort-stability guarantee.

### Engineering

- CI installs with `--ignore-scripts`, so nothing in the dependency tree can
  execute code during install.
- CI adds a GitHub CodeQL static-analysis job (`security-and-quality` queries)
  alongside lint, tests, `npm audit` and the container smoke test.
- Fixed a container build failure: the Dockerfile copied `scripts/`, which
  `.dockerignore` excludes from the build context. The linter is not runtime
  code and is no longer copied.
- Fixed a second container build failure: the runtime stage copied
  `/app/node_modules` out of a stage where `npm ci --omit=dev` installs nothing,
  so the `COPY` had no source and the image never built. The install prefix is
  now copied as a whole, which is correct for an empty dependency tree and a
  populated one alike, and it keeps the lockfile inside the image so a shipped
  artefact can be traced back to an exact dependency set.
- CI actions are pinned to immutable commit SHAs (`actions/checkout` v7.0.1,
  `actions/setup-node` v7.0.0, `github/codeql-action` v3) with the version in a
  trailing comment. A floating tag can be repointed by whoever controls it,
  which turns a routine CI dependency into code execution inside the
  repository; Dependabot refreshes the pins. This also clears the Node.js 20
  runner deprecation warning.
- The container base image is pinned to the `node:24-alpine` manifest digest, so
  the released image is reproducible and an upstream tag re-push cannot change
  what customers run. Dependabot refreshes the digest weekly.
- CI runs on a pinned `ubuntu-24.04` runner (the `ubuntu-latest` label migrates
  to Ubuntu 26 on 2026-10-19), checks out with `persist-credentials: false`, and
  bounds every job with `timeout-minutes` so a hung job cannot burn a runner.
- The DNS-rebinding tests asserted that the rejected `Host` was absent with a
  substring scan over the response body. That pattern is exactly what CodeQL's
  *incomplete string comparison* query flags, and a substring scan also cannot
  distinguish a value from one embedded in a larger host. The tests now compare
  the whole error envelope and match header values exactly: stronger assertions,
  and the alert's root cause is gone rather than suppressed.
- Added `.gitattributes` pinning working trees to LF, so a Windows contributor
  with `core.autocrlf=true` does not fail `npm run lint` on a fresh checkout.
- `LICENSE` carries the full MIT text rather than a two-line stub.
- Removed an unused import in `src/app.js`; suite grows to 211 tests.

## [0.1.0] - 2026-10-02

First working release. Replaces the previous state of the repository, which
contained a two-line README and no source code.

### Added

- **Application**
  - Home inventory web UI: add, search, filter, and delete household items with
    name, category, room, quantity, purchase date, value, notes and tags.
  - JSON API for items: `GET`/`POST /api/items`, `GET`/`PATCH`/`DELETE
    /api/items/:id`.
  - `GET /api/health` (liveness and readiness) and `GET /api/metrics`
    (process counters). Only `/api/health` is exempt from rate limiting, so
    monitoring keeps working under load.
  - Optimistic concurrency on updates: send `version` and receive `409` on a
    stale write.
  - Graceful shutdown on `SIGINT`/`SIGTERM`, with a configurable forced-exit
    deadline.
  - Dockerfile and hardened `docker-compose.yml`; non-root user, read-only root
    filesystem, dropped capabilities, healthcheck.

- **Security**
  - Strict CSP (`default-src 'none'`, no `unsafe-inline`, no `unsafe-eval`)
    applied to every response including error responses.
  - Schema allow-list validation at every boundary, rejecting unknown fields
    (no mass assignment) and `__proto__`/`constructor`/`prototype` keys (no
    prototype pollution).
  - Path-traversal-proof static asset resolution with an extension allow-list.
  - Per-client token-bucket rate limiting with a bounded key space.
  - Bounded JSON request bodies and strict `application/json` enforcement.
  - `X-Request-Id` echoed only when strictly well formed; `X-Forwarded-*`
    honoured only when `TRUST_PROXY=true`.
  - Structured JSON logging with secret redaction and log-forging resistance.
  - Strict calendar validation (impossible dates such as `2026-02-31` rejected).

- **Reliability**
  - `fsync`-backed atomic `rename` persistence with serialised mutations, so a
    crash cannot truncate the database and concurrent writes cannot lose an
    update.
  - A corrupt database fails the boot with an actionable message instead of
    silently starting empty.

- **Engineering**
  - 211-test suite on `node:test`, including negative security cases.
  - Zero-dependency linter (`scripts/lint.mjs`) with a configurable rule set.
  - CI on Node 20/22/24 running lint, tests and `npm audit`, plus CodeQL static
    analysis, a container build and smoke test.
  - Dependabot for npm and GitHub Actions.
  - Full README, `SECURITY.md` threat model, `CONTRIBUTING.md`, `.env.example`.

[Unreleased]: https://github.com/PreCogSecurity/HomeCompass/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PreCogSecurity/HomeCompass/releases/tag/v0.1.0
