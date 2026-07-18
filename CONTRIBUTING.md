# Contributing to OpsCat

Thanks for helping build OpsCat! 🐈

## Licensing of contributions

OpsCat is [open core](docs/OPEN-CORE.md): the public repository
([jpj069/opscat.io](https://github.com/jpj069/opscat.io)) contains the complete
Apache-2.0 community core; the Enterprise Edition (billing, super-admin console,
SSO, managed sensors) is developed in a private repository. By submitting a
contribution to the public repository you agree that it is licensed under
Apache-2.0.

Accepted public contributions are merged into the internal source-of-truth
repository and appear in the public repo with the next sync commit — your
authorship is credited in the sync commit message and release notes.

## Development

```bash
npm run setup                 # install server + web deps
cd server && npm start        # API on :3000 (seeds first admin; community edition)
cd web && npm run dev         # Vite dev server, proxies /api + /v1
```

Run the server as the hosted edition locally with `OPSCAT_EDITION=cloud`.

## Before opening a PR

- `node --check` your changed server files; `cd web && npx tsc --noEmit` for UI.
- Keep tenant isolation intact: every query on a tenant table must be scoped by
  `org_id` (see `docs/ARCHITECTURE.md`). A missing filter is a security bug.
- Never commit secrets. `.env` and `server/data/` are gitignored.
- One logical change per PR; describe what you changed and how you verified it.

## Reporting security issues

Please email security@opscat.io rather than opening a public issue.
