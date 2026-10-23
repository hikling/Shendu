# Testing and Operations

From `shendu/`, run `npm run check` for server, browser script, and administration script syntax. Run `npm test` for the Node test suite (`shendu/package.json`). `shendu/tests/backup-security.test.mjs` starts a server against temporary data and checks account isolation, encryption, backup formats, restore transactions, and rollback. Files under `shendu/tests/fixtures/personal/` are compatibility fixtures.

For changes to encrypted fields, restore, sessions, or account ownership, update behavioral tests at the HTTP or helper boundary. CSS or layout-only changes need visual and interaction verification rather than selector-mirroring tests.

`README.md` documents local startup and deployed data/key locations; `UPGRADING.md` documents upgrade and rollback. `shendu/.env.example`, `shendu/compose.yaml`, and `shendu/Dockerfile` define configuration and deployment. Keep actual `.env`, `data/`, and backup keys out of planning artifacts and test runs. Preserve the production key path across upgrades.
