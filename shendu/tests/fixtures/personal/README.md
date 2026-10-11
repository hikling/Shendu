# Personal backup compatibility fixtures

These five encrypted `.shendu` files contain synthetic Chinese text and use the public test password `fixture-password-2026`. They are fixed inputs for import tests, not production backups. `generate.mjs` is an independent serializer and is not called by the tests.

The public Git history from the first commit containing `shendu/server.mjs` (`aca201ba`) through `7cca30d7` emits `shendu-v4` personal backups. Its reader also accepts `shendu-v3`, `shendu-v2`, `shendu-stream-v2`, and `shendu-encrypted-backup`; the four corresponding fixtures protect that existing compatibility. An unpublished older build may use another format and needs a private sample to verify.

The fixtures cover six review types, Chinese titles and journals, verified/completed/draft records, a verified action, stage and theme settings where present, and current-format template snapshots. Legacy fixtures contain deliberately unsupported fields so preview must disclose their loss. The old-format decision record deliberately has no ID to test repeat imports.
