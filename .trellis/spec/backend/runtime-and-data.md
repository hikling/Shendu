# Runtime and Data

`shendu/server.mjs` is the Node HTTP server and main location for routes, SQLite statements, record rules, sessions, and backup flows. `shendu/scripts/backup-safety.mjs` holds reusable file and Base64 safety helpers. The application uses native ESM and `DatabaseSync` from `node:sqlite` with Node >=22.5 (`shendu/package.json`); there is no ORM or migration package.

At startup, `server.mjs` creates the users, sessions, settings, records, and backup tables with indexes and `schema_meta`. It enables WAL, foreign keys, and a busy timeout. Schema evolution and `migrateSensitiveData()` live in the same file. Queries use prepared statements and value parameters. The record list builds a bounded `WHERE` clause from fixed fragments and argument values.

Multi-row mutations use explicit `BEGIN IMMEDIATE` / `COMMIT` with rollback on error. Registration and backup restore demonstrate this. Preserve transaction boundaries for operations that must succeed together.

Record title, data, verification, settings, and backup credentials are encrypted before persistence. `encryptDataWithKey()` uses AES-256-GCM with scoped AAD, and `dataScope()` ties ciphertext to owner and field. `initialiseMasterKey()` validates candidate keys against stored ciphertext before use and persists the chosen key through `atomicWriteFile()` (`server.mjs`, `scripts/backup-safety.mjs`). Never bypass these helpers, log plaintext, or regenerate a key over existing encrypted data.

Review write periods use `Asia/Shanghai` via `todayDate()` and `currentPeriodFor()`. Matching frontend helpers live in `public/app.js`; keep both sides aligned when changing period rules.
