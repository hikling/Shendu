# Frontend Architecture

## Files and boundaries

- `shendu/public/index.html` provides the application, modal, and toast roots and loads `styles.css` and `app.js` directly. `shendu/package.json` has no frontend framework or bundler.
- `shendu/public/app.js` owns route state, HTML templates, API calls, and event binding. `shell(content)` renders the sidebar, topbar, main area, and right rail. `navigate(route)` selects the view.
- `shendu/public/styles.css` owns global tokens, page styles, and breakpoints. Local fonts live under `shendu/public/assets/fonts/`.

## Render and bind

Page functions return HTML strings. After DOM replacement, they attach listeners to the new nodes. `renderReview()` calls `shell(content)` then `bindReview()`; `shell()` calls `bindCommon()`. A rerender removes old listeners, so every new control needs a binding path.

The six review types share `TYPES`, `QUESTIONS`, `reviewToolbar()`, and `renderReview()`. Daily-specific content is split into `dailyEvidence()`, `dailyReflection()`, `dailyActionFields()`, and `dailyJournal()` in `app.js`. Extend the shared path for common behavior and the daily branch for daily-only behavior.

Daily review uses `DAILY_SECTIONS` and `state.dailySection` to show one writing pane at a time. `dailyReviewHtml()` renders all four panes once, and `showDailySection()` changes `hidden` without replacing form nodes. `updateDailyStatus()` reads current input values; its “已填写” label does not imply that `validateCurrent()` will allow completion. If a new daily control triggers `renderReview()` while there are unsaved edits, call `collectCurrent()` first, as the add/remove item handlers do.

Routes are in-memory names such as `daily`, `history`, `actions`, and `backup`. `attemptNavigate()` guards unsaved input before moving between routes. Calendar and navigation handlers use that guard. Preserve it when adding navigation affordances.

These are current repository conventions. A framework or router migration would be a separate explicit task.

## Static asset cache contract

`shendu/server.mjs` serves non-HTML static assets with `Cache-Control: public, max-age=31536000, immutable`, while HTML is `no-cache`. When changing `shendu/public/app.js` or `styles.css`, change the matching `?v=` URL in `shendu/public/index.html` in the same commit. Otherwise a returning browser can render new HTML or JS with old cached CSS or JS for up to a year. Verify the entry HTML points to the edited assets before visual QA.
