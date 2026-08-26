# AGENTS.md

## Repo shape

- No build step, no bundler, no root `package.json`. The calculators are self-contained HTML + plain JS opened directly in a browser (`index.html` is the landing page).
- `shared.css` and `common.js` hold the styles and DOM/formatting helpers common to all pages (color tokens, card/input/table base styles, path/formatter/binding helpers). Pages link shared.css first and load common.js before their own script; page-specific styles and handlers stay in each page.
- Four apps: Group Expense Tracker (`group-expense-tracker.html`, logic in `tracker-engine.js`, cloud sync in `cloud-client.js`), Retirement Planner (`retirement-calculator.html`, logic in `retirement-engine.js`), FIRE Calculator (`fire-calculator.html`, logic in `fire-engine.js`), and Debt Payoff Calculator (`debt-calculator.html`, logic in `debt-engine.js`) — all following the same pattern.
- `plan-state.js` is the shared UMD state module (unified schema, versioned migrations, `#state=` share-link compression, cross-page prefill mappings). See `docs/workflow-and-payoff.md`.
- `worker/` is the only packaged code: a Cloudflare Worker + D1 backend (TypeScript) for the tracker's optional cloud mode. See `worker/README.md` and design docs in `docs/`.

## Checks

Run from repo root before committing page changes (all zero-dependency, no install):

```sh
node scripts/check-links.js
node scripts/check-handlers.js
node scripts/retirement-tests.js
node scripts/cloud-client-tests.js
node scripts/fire-tests.js
node scripts/debt-tests.js
node scripts/pipeline-tests.js   # requires Node >= 18 (global CompressionStream)
```

Worker suite (from `worker/`): `npm test` runs the real Worker against a `node:sqlite` D1 shim — no wrangler, no install needed. `npm run typecheck` does require `npm install` first.

## Gotchas

- **Inline handlers**: pages use inline `onclick`-style attributes. With no build step, a mistyped handler name fails silently at runtime — `check-handlers.js` exists to catch this. Every handler referenced in HTML must be defined as a top-level function in an included script.
- **Engine/UI split**: keep calculation logic in the `*-engine.js` files (unit-testable via the plain-node test scripts); HTML files hold UI only.
- **Test convention**: root-level tests are hand-rolled zero-dependency Node scripts that exit non-zero on failure — don't introduce a test framework.
- **Worker deploy order**: if you add a migration in `worker/migrations/`, apply it to production (`npm run d1:migrate:prod`) *before* `npm run deploy`. Both need `npx wrangler login` first.
