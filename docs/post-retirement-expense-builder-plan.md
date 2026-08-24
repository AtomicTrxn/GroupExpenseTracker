# Post-Retirement Expense Builder — Feature Spec & Build Plan

## Goal

Replace the retirement planner's single "annual spending" number with an
optional itemized expense builder: the user either keeps entering one flat
yearly amount (today's behavior) or builds a list of line-item expenses —
mortgage, real-estate taxes, insurance, travel, etc., entered as monthly or
annual amounts — and the yearly living cost becomes the sum of those lines,
each inflated appropriately through retirement.

Everything else about the planner (phased spending, healthcare, LTC, one-offs,
withdrawal methods, Monte Carlo) keeps working unchanged on top of it.

## Design decisions

1. **A mode switch, not a replacement.** `spending.mode: 'flat' | 'items'`
   (default `'flat'`, so every existing saved plan and share link behaves
   exactly as before). In `items` mode the flat/phased baseline is ignored;
   healthcare, LTC, and one-offs remain *additive* in both modes — they are
   separate risk models, not budget lines.
2. **Each line carries its own inflation treatment.** Real budgets don't
   inflate uniformly:
   - `general` — inflates with the general inflation assumption (most lines)
   - `medical` — inflates with the medical-inflation assumption
   - `fixed` — nominal payment that does not inflate (e.g. a fixed-rate
     mortgage P&I, a fixed-rate loan). This is the line type that makes the
     feature genuinely useful: a $2,000/mo mortgage today is still $2,000/mo
     nominal in year 20, so its real cost *shrinks*.
3. **Monthly vs annual is per-line input**, normalized to annual internally
   (`monthly × 12`) so the engine only ever sees annual figures.
4. **Optional per-line age window** (`startAge` / `endAge`, blank = whole
   plan): mortgage payoff at 70, downsize proceeds later, etc. Mirrors how
   `oneOffs` already work.
5. **No new categories taxonomy.** A free-text label plus an optional
   category dropdown (Housing, Transportation, Living, Leisure, Other) used
   only for grouping/subtotals in the UI — the engine treats all lines alike.

## Line-item schema

```js
spending.items: [
  {
    label: 'Mortgage',        // free text
    category: 'housing',      // housing|transport|living|leisure|other
    amount: 2000,             // positive number
    frequency: 'monthly',     // 'monthly' | 'annual'
    inflation: 'general',     // 'general' | 'medical' | 'fixed'
    startAge: null,           // null = from retirement (or accumulation end)
    endAge: null              // null = through end of plan
  }
]
```

Annual-equivalent helper exported for tests/UI: `itemAnnual(item)` =
`amount × (frequency === 'monthly' ? 12 : 1)`.

## Work items

### Todo 1 — Engine: state schema + normalization

File: `retirement-engine.js`

- Add `mode: 'flat'` and `items: []` to `defaultState().spending`; bump the
  state version marker `v: 1 → 2`.
- Extend `normalizeState`:
  - `out.spending.mode = sp.mode === 'items' ? 'items' : 'flat'`
  - Normalize each item: clamp `amount ≥ 0`, whitelist `frequency`,
    `inflation`, `category` strings (fall back to defaults), coerce
    `startAge`/`endAge` to int-or-null, keep `label` as string.
  - Keep accepting v:1 inputs silently (missing `mode`/`items` fall back to
    defaults) — old localStorage plans and old share links must load unchanged.
- Add `sampleState()` example lines (mortgage `fixed`/monthly ending at 70,
  property tax `general`, Medicare supplement `medical`) so the demo shows off
  the feature.

Details/gotchas:
- `clampInt(..., null)` path needed for nullable ages — reuse the existing
  `num`/`clampInt` helpers but allow `null` through before clamping.
- Do NOT remove `baseline`/`phased` fields; they stay authoritative in flat
  mode and are what old states carry.

### Todo 2 — Engine: spending math

Files: `retirement-engine.js` — `spendingForYear` (~line 240) and
`baselineComponent` (~line 420)

- Extract the current flat/phased logic into `flatBaselineForYear(S, age, t)`
  (returns the inflated go-go/slow-go/no-go or baseline figure).
- New `itemsForYear(S, age, t)`:
  ```js
  let total = 0;
  for (const it of sp.items) {
    if (it.startAge != null && age < it.startAge) continue;
    if (it.endAge != null && age > it.endAge) continue;
    const rate = it.inflation === 'fixed' ? 0
      : it.inflation === 'medical' ? sp.healthcare.medicalInflation
      : S.assumptions.inflation;
    total += itemAnnual(it) * Math.pow(1 + rate, t);
  }
  ```
- `spendingForYear`: if `sp.mode === 'items' && sp.items.length`, use
  `itemsForYear` in place of the flat baseline; healthcare/LTC/one-off blocks
  untouched after it.
- `baselineComponent` gets the same branch — this is what makes the
  guardrails/four-percent withdrawal methods reshape only the discretionary
  part correctly in items mode. Easy to miss; without it those methods would
  silently use the stale flat number.
- `validate(S)`: warn when `mode === 'items'` and `items.length === 0`
  (spending collapses to healthcare/LTC/one-offs only).

### Todo 3 — Share-link codec v2

File: `retirement-engine.js` — `compactState` / `expandState`

- Bump compact payload to `v: 2`: add `spm: [mode]` and
  `si: items.map(i => [label, category, amount, frequency, inflation,
  startAge ?? '', endAge ?? ''])`.
- `expandState`: accept `v === 2` fully; keep the existing `v === 1` branch
  working verbatim (old shared links in the wild must still open), then run
  both through `normalizeState`.
- Gotcha: `null` ages serialize as `''` and back — test the round trip.

### Todo 4 — Engine tests

File: `scripts/retirement-tests.js` (append; same hand-rolled style)

- Sum: three lines (one monthly) → correct annual total at t=0.
- Monthly ×12 conversion via `itemAnnual`.
- `fixed` line stays constant nominally → real value shrinks by exactly the
  inflation factor over time.
- `medical` line grows at `medicalInflation`, not general inflation.
- Age window: line excluded before `startAge` and after `endAge`.
- Mode equivalence: flat `$60k` vs items summing to `$60k` produce identical
  `projectDeterministic` results (same depletion age and totals).
- Healthcare/LTC/one-offs still additive in items mode.
- Withdrawal-method interaction: `fourPercent` method in items mode reshapes
  only the items component (guards the `baselineComponent` fix).
- Codec: v2 compact→expand round trip preserves items incl. null ages;
  a hand-built v:1 payload still expands correctly.
- Validate warns on empty items list.

Run: `node scripts/retirement-tests.js`.

### Todo 5 — UI: mode toggle + itemized table

File: `retirement-calculator.html` (spending card, ~lines 246–295)

- Segmented control at the top of the spending card: **Flat amount |
  Itemized expenses** (reuse `.segmented` styles + pattern from the withdrawal
  method toggle), bound to `spending.mode`.
- Flat view: existing baseline + phased fields, wrapped in a container hidden
  when in items mode (same `[hidden]` pattern as `.subfields`).
- Items view: dynamic table rendered by new `renderExpenseItems()`, modeled on
  `renderIncome()`/`renderOneOffs()`:
  columns: Label · Category (select) · Amount · Monthly/Annual (select) ·
  Inflation (select) · From age · To age · remove icon-button.
  All cells use `data-path="spending.items.<i>.<field>"` + `bindDynamic()`;
  add/remove via top-level `addExpenseItem()` / `removeExpenseItem(i)`
  handlers (check-handlers.js requires top-level definitions).
- Live subtotal line under the table: "Total: $X/yr in today's dollars"
  computed from `itemAnnual` sums, updating on every edit.
- `fullRender()` calls `renderExpenseItems()` alongside `renderIncome()` /
  `renderOneOffs()`.
- The year-by-year table needs no change — it already displays
  `r.spending`, which now reflects the summed items automatically.

### Todo 6 — CSV round-trip

File: `retirement-calculator.html` — `handleCsvImport` (~line 858)

- Export needs no change: `flatten()` already walks nested arrays generically.
- Import: add `draft.spending.items = [];` next to the existing
  `draft.spending = { oneOffs: [] }` reset so re-imported files rebuild the
  array from indices instead of appending ghosts.

### Todo 7 — Docs + verification

- Update the Retirement Planner bullet in `README.md` (mention itemized
  post-retirement budget with per-line inflation and age windows).
- No `AGENTS.md` change needed (structure unchanged).
- Run the full root check suite: `check-links`, `check-handlers`,
  `retirement-tests`, `cloud-client-tests`, `fire-tests`.

## Explicitly out of scope

- Per-line Monte Carlo variance or shock events (planner-level volatility
  already covers the portfolio side).
- Debt payoff amortization schedules — a `fixed` line with an `endAge`
  approximates a payoff well enough for planning.
- Editing items inside scenario slots beyond what the existing save/load
  already captures (scenarios snapshot whole state, so they inherit items
  support for free).

## Suggested commit shape

1. `feat(retirement): itemized post-retirement expenses (engine + codec + tests)`
2. `feat(retirement): expense builder UI and CSV round-trip`
3. `docs: update README for itemized retirement expenses`
