## Pull request checklist

- [ ] `npm ci && npm run lint && npm test` passes locally.
- [ ] New behaviour is covered by tests in `test/` (tests are part of the change, not a follow-up).
- [ ] New or changed configuration is documented in `README.md` and `.env.example`.
- [ ] Untrusted input is validated at the boundary, in `src/lib/validate.js`.
- [ ] Nothing sensitive is logged; secret-shaped fields are redacted by `src/lib/logger.js`.
- [ ] No new runtime or dev dependency was added (see `CONTRIBUTING.md`).
