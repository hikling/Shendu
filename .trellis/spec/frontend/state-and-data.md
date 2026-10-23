# Frontend State and Data

## State

`state` in `shendu/public/app.js` holds the user, stage, theme, records, stats, route, current record, dirty/saving flags, and drawer/modal state. `boot()` calls `refreshData()` for `/api/me`, `/api/records`, and `/api/stats`, then opens `daily`. `applyTheme()` maps saved colors to CSS variables.

Use `request()` for JSON API operations. It sends same-origin credentials and handles error responses. `sessionExpired()` keeps unsaved form content while reauthentication is shown. Escape data placed into template HTML with `esc()`; `toast()` uses `textContent`.

## Review lifecycle

- `newRecord()` defines draft shape; `renderReview()` loads a record or draft. `templatesForRecord()` respects the saved template snapshot.
- `bindReview()` marks editable inputs dirty. `collectCurrent()` copies current DOM values into `state.current.data`. Collect before a rerender that replaces form nodes; `renderReviewFromCurrent()` demonstrates this for add/remove item actions.
- `saveCurrent()` explicitly sends `PUT /api/records`, updates the record cache, and clears dirty state. The current app has no automatic draft save.
- `validateCurrent()` checks required answers before `completeCurrent()` confirms and locks the record. Completed and historical records are read-only. The server also enforces period, version, and status rules.
- `attemptNavigate()` and `beforeunload` warn about unsaved changes. A local section switch must retain unsaved input and must not be treated as route departure.

Dates use `Asia/Shanghai` in `today()`, `defaultPeriod()`, and related frontend helpers, matching `currentPeriodFor()` in `server.mjs`. Preserve record shape, `version`, `draft/completed/verified` statuses, and template snapshots unless an API migration is explicitly planned.
