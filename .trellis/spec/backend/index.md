# Backend Guidelines

Read these guides before changing `shendu/server.mjs` or `shendu/scripts/`.

## Pre-development checklist

1. Read [Runtime and data](./runtime-and-data.md) for SQLite, encryption, and time boundaries.
2. Read [HTTP and security](./http-and-security.md) for authentication, validation, and record lifecycle.
3. Read [Testing and operations](./testing-and-operations.md) for safe local verification.

## Quality check

- Run `npm run check` and `npm test` from `shendu/` for backend or shared API changes.
- Check account ownership, period locks, version conflicts, encrypted fields, and rollback behavior where affected.
- Use isolated temporary data. Never point local checks at deployed `data/` or a real master key.

## Guides

- [Runtime and data](./runtime-and-data.md)
- [HTTP and security](./http-and-security.md)
- [Testing and operations](./testing-and-operations.md)
