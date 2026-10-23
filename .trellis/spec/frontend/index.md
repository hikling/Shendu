# Frontend Guidelines

Shendu's browser UI is a native JavaScript single-page application. Read these guides before changing `shendu/public/`.

## Pre-development checklist

1. Read [Architecture](./architecture.md) for rendering and event binding.
2. Read [State and data](./state-and-data.md) before changing forms, navigation, or save behavior.
3. Read [UI quality](./ui-quality.md) before changing layout, themes, or dialogs.
4. Trace any changed record payload or completion rule through `shendu/server.mjs`.

## Quality check

- Run `npm run check` in `shendu/`.
- Check affected routes at desktop and narrow mobile widths, including keyboard focus, drawers, dialogs, theme presets, custom colors, and reduced motion.
- For review forms check new, dirty, saved, locked, and historical read-only records.
- Run `npm test` when API, persistence, security, or backup behavior changes.

## Guides

- [Architecture](./architecture.md)
- [State and data](./state-and-data.md)
- [UI quality](./ui-quality.md)
