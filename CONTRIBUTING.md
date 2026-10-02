# Contributing to HomeCompass

Thanks for helping. This is a small project with a strict opinion about its own
size, so please read the rules below before opening a pull request.

## Ground rules

1. **Tests ship with the change.** A behaviour change without a test that fails
   before it and passes after it is not finished.
2. **One logical change per commit.** "Add room filter" and "reformat the store"
   are two commits. Reviewers and future archaeology both benefit.
3. **No new dependencies without discussion.** Open an issue first and explain
   what the dependency buys and what the risk is. The zero-dependency posture is
   a deliberate security property, not an accident.
4. **Never log secrets.** Use `src/lib/logger.js`; it redacts secret-shaped keys
   and escapes control characters for you.
5. **Never interpolate user input into an error message or a log message.**
   Validation errors name fields, never values.

## Getting set up

```bash
npm ci
npm run check     # lint + tests
npm start
```

You need Node.js >= 20.12. `.nvmrc` pins the version we develop against.

## Before you push

```bash
npm run lint      # must be clean
npm test          # must exit 0
npm audit --audit-level=high
```

CI runs the same three commands on Node 20, 22 and 24, and builds the container.
All of it must pass.

## Adding a feature

- Validate any new input in `src/lib/validate.js`. Add the field to the relevant
  schema; unknown fields are rejected by design, so a new field needs a schema
  entry to be accepted at all.
- Render any new API value in `public/assets/app.mjs` with `textContent`. The
  `no-inner-html` lint rule enforces this.
- Put pure client logic in `public/assets/items.mjs` so it can be unit tested
  without a browser.
- Document new configuration in both `README.md` and `.env.example`.
- Update `SECURITY.md` if you change the threat surface.

## Adding tests

Tests use `node:test`. Name the file after the module it covers
(`src/lib/store.js` -> `test/store.test.js`). Prefer real behaviour over mocks:
`test/helpers/harness.mjs` boots the actual application on an ephemeral port
with a temporary database.

```js
import assert from 'node:assert/strict';
import test from 'node:test';

test('rejects an empty name', async () => {
  const harness = await startTestServer();
  try {
    // ...
  } finally {
    await harness.close();
  }
});
```

For security-relevant behaviour, add the negative test too — the traversal case,
the prototype-pollution case, the oversized body. Those are the regressions that
actually matter.

## Commit messages

Short, imperative, lowercase subject under 72 characters.

```text
add room filter to item list endpoint
reject unknown fields on item patch
atomic rename on inventory write
```

## Reporting security issues

Please follow [SECURITY.md](SECURITY.md) rather than opening a public issue.
