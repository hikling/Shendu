# Current UI and source evidence

Reviewed GitHub `main` at `e24da0371b4b08701137744db6ac677391667e3f` on 2026-10-23. The working folder is now a formal Git checkout. The earlier archive extraction remains as an isolated baseline copy.

- `shendu/package.json`: native ESM, Node >=22.5; `check` and `test` scripts.
- `shendu/public/index.html`: direct browser app/style entry points.
- `shendu/public/app.js:83-94`: in-memory state, API request, theme application.
- `shendu/public/app.js:136-166`: sidebar/topbar/shell, calendar and right rail.
- `shendu/public/app.js:181-227`: four daily sections, all-at-once review rendering, dirty tracking, explicit draft save, completion.
- `shendu/public/app.js:401-424`: modal, unsaved navigation guard, shared event binding, route selection, initial data load.
- `shendu/public/styles.css:4-18`: existing token colors and wide-screen shell.
- `shendu/public/styles.css:39-44`: 1199px right-rail and 820px sidebar transitions plus narrow layout rules.
- `shendu/server.mjs:1127-1230`: API routing, authentication, settings, stats, current-period and record write rules.
- `shendu/tests/backup-security.test.mjs`: security and backup test coverage; no existing browser UI automation.

The main density problem is structural: stats, toolbar, all four writing sections, navigation, and right rail compete in one view. The planned change prioritizes the writing job while retaining the current record payload and save contract.

## Rendered baseline

- Ran the archive copy on local port 3107 with a newly generated key and isolated temporary data directory. The test account and data are local only.
- Saved 1440-ish desktop and 390×844 mobile first-viewport captures to `screenshots/baseline-desktop.png` and `screenshots/baseline-mobile.png`.
- Desktop: intro, three dark statistic cards, toolbar, then the first writing section below the fold; stage/calendar/pending actions occupy an always-visible rail.
- Mobile: intro followed by three stacked statistic cards. The writing form is below multiple screens of scrolling; the navigation drawer is available from the top bar.
- Existing route set includes daily, weekly, monthly, annual, decision, history, actions, backup, account and settings; the 90-day route is conditional on stage configuration. Theme and manual-save behavior are implemented in `applyTheme()`, `bindReview()`, `saveCurrent()` and `attemptNavigate()`; these paths must be rechecked after the UI edit.
