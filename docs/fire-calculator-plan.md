# FIRE Calculator — Feature Spec & Build Plan

## Goal

Add a third calculator answering the three canonical FIRE questions from one
shared set of inputs:

1. **FIRE number** — how big does the portfolio need to be to fund $X/year of
   living expenses *after taxes*?
2. **Coast FIRE number** — how much invested *today* grows into that number by a
   target age with no further contributions (and: what will my current balance
   actually be worth by then)?
3. **Years to FI** — on my current trajectory (balance + annual savings), when
   do I cross the line?

These three are the standard trio across FIRE tools (firenum, investingoal,
infoz, etc.). Alternatives considered for #3 were the Lean/Barista/Fat flavor
variants and a savings-rate sensitivity table — both are cheap follow-on phases
(see Phasing) rather than a third headline question, because they re-shape the
same target rather than answer a new one.

## Design principles

Inherited from the repo's existing calculators:

- **Self-contained** — one HTML file + one engine file, no build step, no
  dependencies, no backend. Data stays in the browser (`localStorage`).
- **Transparent** — every assumption (return, inflation, withdrawal rate, tax
  rate) is an on-screen editable input, never a hidden constant.
- **Engine/UI split** — all math in `fire-engine.js` (UMD: `window.FireEngine`
  in browser, `module.exports` in Node), HTML holds UI only. Unit-testable via
  a plain-node script per repo convention.
- **Progressive disclosure** — a handful of inputs produce a result; advanced
  fields live behind expanders.

## The three calculations

All math runs in **real (today's-dollar) terms**: the engine converts nominal
return to real return via `(1 + nominal) / (1 + inflation) − 1`, so the FIRE
number is expressed in today's dollars and stays intuitive. Inflation is still
an input because it drives the conversion.

### 1. FIRE number (tax-aware)

The 4%-rule classic, grossed up for taxes. Withdrawals must cover spending
*plus* the tax owed on the withdrawal:

```
grossWithdrawal = annualSpending / (1 − effectiveTaxRate)
fireNumber      = grossWithdrawal / withdrawalRate
```

Defaults: `withdrawalRate = 4%` (editable — 3–3.5% is common for early/long
retirements), `effectiveTaxRate = 15%` (blended rate on a mixed
traditional/Roth/taxable drawdown; editable). A flat effective rate keeps this
calculator honest without duplicating the retirement planner's full
account-type model — the planner remains the deep tool; this one is the quick
one. The output panel shows the chain explicitly: spending → gross withdrawal →
number, so the tax effect is visible, not buried.

### 2. Coast FIRE number

```
coastNumber = fireNumber / (1 + realReturn) ^ (targetAge − currentAge)
```

Also answers the user's framing directly: "I have $200K today" → project it
forward (`200000 × (1+r)^n`) and compare against the FIRE number, showing
progress toward coast status (`currentBalance / coastNumber`). If the balance
already exceeds the coast number, say so plainly: "you can stop saving and
still hit your number by age N."

### 3. Years to FI

Year-by-year iteration (not just the closed form) so the table can double as
the progress view:

```
balance[n] = balance[n−1] × (1 + realReturn) + annualSavings
```

Iterate until `balance ≥ fireNumber`, capped at 80 years (flag unreachable
paths). Inputs: current balance, annual savings (with optional helper: enter
income + expenses and derive savings). Output: years to FI, FI age/date,
progress %.

## Files & wiring

| File | Purpose |
| --- | --- |
| `fire-calculator.html` | UI only |
| `fire-engine.js` | Pure math, UMD pattern matching `retirement-engine.js` |
| `scripts/fire-tests.js` | Zero-dependency hand-rolled tests, same style as `retirement-tests.js` |
| `index.html` | Add landing-page card |
| `README.md`, `AGENTS.md` | Add `node scripts/fire-tests.js` to the checks list |

`check-links.js` and `check-handlers.js` pick the new page up automatically
(they scan all root HTML files).

### Engine API sketch

```js
FireEngine.defaultState()          // editable defaults, versioned { v: 1 } like the planner
FireEngine.realReturn(state)       // nominal → real conversion
FireEngine.fireNumber(state)       // { grossWithdrawal, fireNumber }
FireEngine.coastNumber(state)      // { coastNumber, projectedBalance, yearsToTarget, coastProgress }
FireEngine.yearsToFi(state)        // { years, fiAge, reachable, schedule[] }
FireEngine.fullProjection(state)   // combined year-by-year table for the UI
```

Everything deterministic — no Monte Carlo in scope (the retirement planner owns
that).

## UI layout

Single page, three result cards sharing one input panel:

1. **Your FIRE number** — headline number + the spending→gross→number breakdown.
2. **Coast FIRE** — coast number, projected value of current balance at target
   age, progress bar, plain-language verdict.
3. **Timeline** — years to FI, FI age, progress bar, year-by-year table
   (collapsible).

Advanced expander: withdrawal rate, effective tax rate, nominal return,
inflation, target age, savings derivation helper.

## Phasing

- **Phase 1 (MVP)** — engine + tests for all three calculations, single-column
  UI, localStorage persistence, landing-page card, checks updated. Ship after
  review of this plan.
- **Phase 2 (optional)** — Lean/Barista/Fat flavor chips (multipliers on the
  same target), savings-rate-vs-years sensitivity table, simple growth chart
  (inline SVG, no library).
- **Out of scope** — account-type tax modeling, Social Security, Monte Carlo:
  the retirement planner already covers these deeply.

## Test cases to lock down

- 4%/no-tax identity: $40k spend, 0% tax, 4% WR → $1,000,000.
- Tax gross-up: $40k spend, 20% tax, 4% WR → $50,000 gross → $1,250,000.
- Coast: $1M target, 5% real, 35 years → ≈$181,290 (matches published examples).
- Projection: $200k at 5% real for 30 years → ≈$864,388.
- Years-to-FI closed-form cross-check against the iterated table.
- Unreachable path flagged (huge target, zero savings).
- Edge cases: zero years to target (age ≥ target), 100% withdrawal rate guard,
  negative/zero return.
