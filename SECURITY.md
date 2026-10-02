# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for a
vulnerability.

Use GitHub's private reporting form on this repository
("Security" -> "Report a vulnerability"). Include:

- what you did, step by step;
- what you expected, and what happened instead;
- the request/response or configuration needed to reproduce;
- the impact you believe it has.

We aim to acknowledge within 3 working days and to ship a fix or a mitigation
plan promptly. If a fix will take a while we will say so rather than go quiet.

## Threat model in one paragraph

HomeCompass is designed to run on a machine the owner controls, reachable from
their own browser. It holds a moderately sensitive inventory (what you own, what
it is worth, where it is) but it is **not** designed to be exposed directly to
the public internet.

**Defended against:**

- cross-site scripting (strict CSP, no `innerHTML`, `textContent` rendering);
- **DNS rebinding**, the main risk created by shipping no authentication — see
  below;
- prototype pollution and mass assignment (schema allow-list, forbidden keys);
- path traversal and arbitrary file reads (extension allow-list, lexical *and*
  real-path containment, so symlinks cannot escape the document root);
- request flooding and slow-loris (body caps, header timeouts, rate limiting);
- log forging and secret leakage into logs (redaction, control-char escaping);
- silent data loss (fsync + atomic writes, corruption refuses to start);
- naive credential and identity spoofing via headers (`TRUST_PROXY` off by default).

### DNS rebinding

This is worth its own section because it is the vulnerability the "no
authentication" decision would otherwise hand you for free.

HomeCompass binds to loopback and ships no login. A hostile web page served from
`evil.example` can set a DNS record pointing `homecompass.local` at `127.0.0.1`
and then reload. The browser compares origins by *name*, so from that point on
the request is **same-origin**: `fetch('/api/items')` returns the attacker's
readable inventory and `POST` rewrites it. No CORS exemption is required, which
means adding CORS headers later would not fix it.

HomeCompass therefore validates the `Host` header against an allow-list
(`localhost`, the loopback addresses, the configured `HOST`, and anything in
`ALLOWED_HOSTS`) and answers `421 Misdirected Request` before any routing,
storage or asset resolution happens. The rejected value is never echoed back, so
the endpoint cannot be abused as a header oracle.

If you terminate TLS at a reverse proxy on a real hostname, add that hostname to
`ALLOWED_HOSTS`. Setting `ALLOWED_HOSTS=*` disables the guard; only do that on a
machine you alone control.

**Not defended against — read before you expose this service:**

- **No authentication or authorisation.** Anyone who can reach the port can read
  and modify the entire inventory. There is no login, no per-user separation, and
  no encryption at rest. The DNS-rebinding guard in the section above is what
  keeps this from being reachable *from a web page you happen to be visiting*.
  Put it behind a reverse proxy that terminates TLS and enforces authentication
  if it must leave your machine.
- **No encryption at rest.** `data/items.json` is plaintext, readable by any
  process running as your user. It is gitignored; keep it that way.
- **Operational counters are opt-in in production.** `/api/metrics` returns 404
  unless `METRICS_ENABLED=true`, because the counters reveal how much you own.
  `/api/health` deliberately discloses nothing beyond liveness.
- **Rate limiting is per-process and in-memory.** It resets on restart and is not
  shared across replicas.
- **Single-writer storage.** The database is a JSON file; do not point multiple
  instances at one file.
- **No CSRF tokens.** The API accepts same-origin JSON. A browser on another
  origin cannot read responses, but do not enable permissive CORS anywhere in
  front of this service.
- **The bundled container runs an unprivileged user, but the host is your
  responsibility.**

## Hardening notes for operators

1. Keep `HOST=127.0.0.1` unless a proxy is in front.
2. Keep `TRUST_PROXY=false` unless a proxy you control sets the forwarding
   headers. Enabling it blindly lets any client forge its identity and evade
   throttling.
3. Serve it under a real hostname? Set `ALLOWED_HOSTS` to that hostname, or the
   DNS-rebinding guard will reject your own browser's requests.
4. Terminate TLS at the proxy. The app speaks plain HTTP; it emits HSTS only when
   TLS termination is correctly declared.
5. Back up `data/items.json`. It is the whole database, and it is gitignored so
   it will not save you through a commit.
6. Run the container as described in `docker-compose.yml`: non-root, read-only
   root filesystem, all capabilities dropped.
7. Keep Node.js patched. HomeCompass uses `process.loadEnvFile`,
   `Object.hasOwn`, `AbortController` and the built-in test runner, so it tracks
   the runtime.

## Supply chain posture

The runtime dependency tree is empty by design. `npm ci` resolves no packages,
and `npm audit` cannot report a finding. CI installs with `--ignore-scripts`, so
nothing in the dependency tree can execute code during install even if one were
added later. `.github/dependabot.yml` keeps the Node version, the GitHub Actions
used by CI, and any future dependency current.

CI runs the lint rules, the `node:test` suite, `npm audit --audit-level=high`,
a container build with a live health-check smoke test, and GitHub CodeQL static
analysis (`security-and-quality` queries) as an independent SAST pass over
JavaScript.

Actions in CI are referenced by version tag rather than commit SHA. Pinning to
SHAs is the stronger option and is tracked as follow-up work; Dependabot updates
those tags.

## Verifying a build

```bash
npm ci
npm run check      # lint + tests
npm audit --audit-level=high
```
