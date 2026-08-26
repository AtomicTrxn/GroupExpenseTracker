# Unified State & Debt Payoff Calculator — Implementation Plan (rev 2)

## Overview

This document specifies:

1. **Debt Payoff Calculator** — a new calculator completing the liabilities → accumulation → decumulation trilogy.
2. **Cross-page plan handoff** — opt-in share/prefill links so each calculator can seed the next.
3. **Unified state foundation** (`plan-state.js`) — a versioned, migrated, optionally URL-encoded state container, introduced incrementally.

### Design principles (changed in rev 2)

- **Engines stay canonical.** The unified schema nests each engine's *verbatim* `defaultState()` output under its own key. No parallel shapes, no adapters. If an engine adds a field, the unified schema inherits it automatically.
- **Pure logic is Node-testable.** All state/migration/compression logic lives in a new UMD module (`plan-state.js`), matching the `fire-engine.js` pattern. `common.js` remains DOM-only helpers. Per AGENTS.md: calculation/state logic belongs in engine-style files testable via plain-node scripts.
- **URL embedding is opt-in.** Full financial state is written to the URL only when the user clicks "Copy share link" — never automatically on keystrokes. This preserves the "Private / on-device" promise made on every page footer and the landing page badges.
- **Incremental rollout.** The debt calculator ships standalone first (own storage key). Cross-page prefill ships second (read-only handoff via hash). Rewriting FIRE/retirement persistence onto the unified store happens last, gated on the prefill workflow proving useful.

---

## Part A — Debt Payoff Calculator

### A.1 Files to Create

| File | Purpose |
|------|---------|
| `debt-engine.js` | Pure math (UMD, same footer pattern as `fire-engine.js:14-18`), exposes `DebtEngine` |
| `debt-calculator.html` | UI, state wiring, rendering |
| `scripts/debt-tests.js` | Zero-dependency unit tests |

### A.2 Storage (standalone phase)

The debt page uses its own key and the exact `loadState`/`saveState` pattern from `fire-calculator.html:168-181`:

```js
const STORAGE_KEY = 'debt-calculator-state-v1';
```

No dependency on the unified store until Part D lands.

### A.3 Engine API (`debt-engine.js`)

```js
DebtEngine = {
  // State
  defaultState(),        // { v: 1, debts: [], monthlyDebtBudget: 0, debtStrategy: 'avalanche' }
  sampleState(),         // mirrors FireEngine.sampleState() convention
  normalizeState(input), // clamps, validates, fills defaults (see ranges below)
  validate(state),       // non-fatal warnings, mirrors fire-engine.js:129-145

  // Primitives (exported for testing, like fire-engine.js:246-256)
  runStrategy(state, orderFn),
  avalancheOrder(debts), snowballOrder(debts),

  // Combined
  payoffProjection(state),   // selected strategy → full result
  compareStrategies(state),  // { avalanche: {...}, snowball: {...}, savings: {...} }

  // Constants
  MAX_MONTHS: 600,      // 50-year cap
  PAYOFF_EPSILON: 0.01  // balances at/below this count as paid
}
```

**Normalize ranges** (mirroring `fire-engine.js:100-126` conventions):

| Field | Clamp / fallback |
|---|---|
| `debts[].balance` | `max(0, num(v, 0))` |
| `debts[].apr` | clamp `[0, 1]`, fallback `0` |
| `debts[].minPayment` | `max(0, num(v, 0))` |
| `debts[].name` | `String(...)` fallback `'Debt N'` |
| `monthlyDebtBudget` | `max(0, num(v, 0))` |
| `debtStrategy` | one of `avalanche \| snowball \| custom`, else `'avalanche'` |

Malformed debt entries (null, non-object) become empty placeholder rows, matching `normalizeItem` behavior in `fire-engine.js:75-82`.

**Validate warnings** (non-fatal, like `validate` in `fire-engine.js:129-145`):

- Empty debt list.
- `monthlyDebtBudget < Σ minPayments` of active debts — minimums will always be paid but the budget cap cannot hold (see A.4 note 1).
- Any active debt where `minPayment ≤ balance × apr / 12` — negative amortization; balance grows every month.
- Unpayable within `MAX_MONTHS`.

### A.4 Core Algorithm (fixed in rev 2)

Month-by-month iteration, same style as `yearsToFi` in `fire-engine.js:202-231`. Conventions locked by tests:

```js
function runStrategy(state, orderFn) {
  const debts = state.debts.map(d => ({ ...d, interest: 0, payment: 0 }));
  const schedule = [];
  let month = 0;

  const active = list => list.filter(d => d.balance > PAYOFF_EPSILON);

  while (active(debts).length && month < MAX_MONTHS) {
    month++;

    // 1. Accrue interest on all active debts (interest-before-payment convention).
    debts.forEach(d => {
      if (d.balance <= PAYOFF_EPSILON) return;
      d.interest = d.balance * (d.apr / 12);
      d.balance += d.interest;
    });

    // 2. Pay minimums. NOTE: minimums are always paid in full even if they
    //    exceed monthlyDebtBudget — the budget caps EXTRA payments only.
    //    This matches real-world behavior (missed minimums = default) and is
    //    covered by a validate() warning rather than silent pro-rating.
    let remaining = state.monthlyDebtBudget;
    debts.forEach(d => {
      if (d.balance <= PAYOFF_EPSILON) return;
      const pay = Math.min(d.minPayment, d.balance);
      d.balance -= pay;
      remaining -= pay;
      d.payment = (d.payment || 0) + pay;
    });

    // 3. Extra payments roll through targets in strategy order until the
    //    budget is exhausted. (Rev 1 applied extra to a single target per
    //    month, stranding leftover budget after a payoff — fixed here.)
    let target = orderFn(active(debts));
    while (target && remaining > PAYOFF_EPSILON) {
      const pay = Math.min(remaining, target.balance);
      target.balance -= pay;
      target.payment += pay;
      remaining -= pay;
      target = orderFn(active(debts));
    }

    // 4. Snapshot (same row shape philosophy as yearsToFi's schedule).
    schedule.push({
      month,
      debts: debts.map(d => ({
        name: d.name,
        balance: Math.max(0, d.balance),
        interest: d.interest,
        payment: d.payment
      })),
      totalBalance: debts.reduce((s, d) => s + Math.max(0, d.balance), 0),
      totalInterest: debts.reduce((s, d) => s + d.interest, 0),
      remainingBudget: Math.max(0, remaining)
    });
    debts.forEach(d => { d.interest = 0; d.payment = 0; });
  }

  const payable = active(debts).length === 0;
  return {
    months: payable ? month : null,   // null mirrors reachable:false in fire-engine.js:230
    payable,                          // false ⇒ flagged unpayable at the cap
    totalInterest: schedule.reduce((s, r) => s + r.totalInterest, 0),
    debtFreeDate: payable ? addMonths(new Date(), month) : null,
    schedule
  };
}

// Strategy orders operate on ACTIVE debts only.
// Avalanche: highest APR first. Snowball: lowest balance first.
// Custom: stored debts[] array order (UI provides ▲/▼ reorder buttons —
// inline handlers, per repo convention; no drag-and-drop).
function avalancheOrder(activeDebts) {
  return activeDebts.slice().sort((a, b) => b.apr - a.apr)[0] || null;
}
```

**Locked conventions (each covered by a named test):**

1. Minimums always get paid; budget caps extras only.
2. Interest accrues before payments.
3. Freed minimums flow into extra payments automatically (a paid-off debt stops consuming budget).
4. Leftover budget redistributes to the next target within the same month.
5. Balances at/below `PAYOFF_EPSILON` are settled; no infinite loops from float residue.

### A.5 UI Layout (`debt-calculator.html`)

Follows the established page skeleton: `shared.css` first, page-specific `<style>` block, results cards above inputs, inline handlers, `data-path` binding via `bindStaticInputs()`/`bindDynamic()` copied from `fire-calculator.html:252-274`.

| Card | Content |
|------|---------|
| **1. Payoff Summary** | "Debt-free in X years Y months · $Z total interest · Strategy: Avalanche"; progress bar using the `.bar`/`.fill` pattern from `fire-calculator.html:80-81`; `payable === false` renders the "80+ yrs"-style unreachable verdict (cf. `fire-calculator.html:325-327`) |
| **2. Strategy Comparison** | Avalanche vs. snowball: months, total interest, interest saved |
| **3. Month-by-Month Schedule** | Collapsible `<details>` table; auto-open only when ≤ 50 rows (matches `fire-calculator.html:344`) |
| **Inputs** | Debt rows (name, balance, APR `%` via `data-type="pct"`, min payment) bound with `bindDynamic`; budget input; strategy segmented control (`.segmented` from `shared.css`); ▲/▼ reorder buttons for custom mode |

Issues render into `<ul class="issues">` from `DebtEngine.validate(...)`, same as `fire-calculator.html:346-347`.

### A.6 Debt State Slice

```json
{
  "v": 1,
  "debts": [{ "name": "Chase Visa", "balance": 12000, "apr": 0.24, "minPayment": 300 }],
  "debtStrategy": "avalanche",
  "monthlyDebtBudget": 2500
}
```

### A.7 Derived Link to FIRE (display-only in this phase)

```js
// In debt-calculator.html recompute()
const result = DebtEngine.payoffProjection(state);
// Integer age: fractional ages would break data-type="int" inputs (common.js coerce).
const debtFreeAge = state.you.currentAge == null ? null
  : Math.ceil(state.you.currentAge + result.months / 12);

// Display-only context line. Rev 1 auto-wrote currentAge and annualSavings
// into shared state; rev 2 never mutates another page's inputs implicitly.
showDerived(`→ ${fmtCompact(state.monthlyDebtBudget * 12)}/yr available for
  investing once debt-free (around age ${debtFreeAge}). Use “Copy link for
  FIRE Calculator” to carry these numbers over.`);
```

**Economics caveat (must appear in UI copy):** during payoff years the budget services debt, not investments. A FIRE projection started today with `annualSavings = budget × 12` overstates wealth during the debt period. The prefilled value is valid *from debt freedom*, and the FIRE page presents it as a suggested starting point the user can adjust (or model as a "no savings until age X" ramp — see §Future Extensions).

### A.8 `scripts/debt-tests.js`

Structure copies `scripts/fire-tests.js` (`test`/`assert`/`approx` harness, exit-nonzero footer). Required coverage:

- **Closed-form cross-check** (the signature move of `fire-tests.js:111-124`): single debt, fixed payment — iterated months match `n = -ln(1 − r·B/P) / ln(1 + r)` where `r = apr/12`.
- Avalanche minimizes total interest vs. snowball on a mixed-APR fixture.
- Snowball clears its first debt sooner on the same fixture.
- Minimum-payment roll-over: freed minimums reach the next target the same month.
- Mid-month redistribution: extra that clears target N hits target N+1 in the same month.
- Budget-caps-extras-only: `budget < Σ minimums` still pays all minimums; `remainingBudget` floors at 0 in snapshots.
- Custom order respected; reorder equivalence (custom order == avalanche order produces identical schedules).
- Unpayable debt: `payable === false`, `months === null`, `schedule.length === MAX_MONTHS`.
- Negative-amortization case flags in `validate`.
- Normalize clamps per the A.3 table; malformed/null debt entries sanitized (mirror `fire-tests.js:154-168, 223-233`).
- Zero-budget, zero-minPayment, single-debt, already-zero-balance degenerate cases.
- `compareStrategies` consistency: both strategies run on identical normalized inputs.

---

## Part B — `plan-state.js`: Shared State Module (UMD)

New file, UMD footer identical to `fire-engine.js:14-18`. Required by pages via `<script src="plan-state.js">` (after `common.js`, before page script) and by `pipeline-tests.js` via `require`. **No ES module syntax anywhere** — pages load classic scripts and rely on globals for inline handlers (`check-handlers.js` contract).

### B.1 Unified Schema (v1) — derived from real engine defaults

```json
{
  "v": 1,
  "meta": { "created": 1700000000000, "lastEdited": 1700000000000, "origin": "debt-calculator" },
  "you": { "currentAge": 35 },
  "debts": [],
  "debtStrategy": "avalanche",
  "monthlyDebtBudget": 0,
  "fire": {
    "v": 1,
    "you": { "currentAge": 35, "targetAge": 65 },
    "money": { "mode": "flat", "annualSpending": 60000, "items": [], "currentBalance": 200000, "annualSavings": 24000 },
    "assumptions": { "withdrawalRate": 0.04, "taxRate": 0.15, "nominalReturn": 0.08, "inflation": 0.03 }
  },
  "retirement": {
    "v": 2,
    "you": { "currentAge": 40, "retireAge": 67, "endAge": 95 },
    "accounts": { "taxable": 50000, "traditional": 150000, "roth": 40000, "cash": 20000, "hsa": 0 },
    "...": "full RetirementEngine.defaultState() shape, verbatim"
  }
}
```

Rules:

- `fire` and `retirement` slices are **exact engine states** — built by calling `FireEngine.defaultState()` / `RetirementEngine.defaultState()`, never hand-rolled. Rev 1's invented flat shapes (which dropped `money.mode`/`items` and misread `accounts` as an array) are gone.
- Top-level `you.currentAge` is the **shared age anchor**. Each engine keeps its own internal `you` (FIRE also has `targetAge`; retirement has `retireAge`/`endAge`). On load, a page syncs its internal `you.currentAge` from the anchor; on save it writes back. `birthYear` is dropped — redundant against `currentAge` and drift-prone.
- Derived values are never stored.

```js
function defaultFullState() {
  return {
    v: STATE_VERSION,
    meta: { created: Date.now(), lastEdited: Date.now(), origin: null },
    you: { currentAge: 35 },
    debts: [], debtStrategy: 'avalanche', monthlyDebtBudget: 0,
    fire: FireEngine.defaultState(),
    retirement: RetirementEngine.defaultState()
  };
}

function normalizeFullState(s) {
  const out = defaultFullState();
  if (s.you && Number.isFinite(Number(s.you.currentAge))) {
    out.you.currentAge = clampInt(s.you.currentAge, 0, 120, out.you.currentAge);
  }
  // Verbatim engine normalization — no adapters (rev 1's
  // FireEngine.normalizeState({...}).fire returned undefined; removed).
  if (s.fire) out.fire = FireEngine.normalizeState(s.fire);
  if (s.retirement) out.retirement = RetirementEngine.normalizeState(s.retirement);
  if (Array.isArray(s.debts)) out.debts = s.debts.map(normalizeDebt);
  // ... debtStrategy / monthlyDebtBudget clamps per A.3
  return out;
}
```

Note: `defaultFullState()` references the engine globals lazily (inside the function body), so load order (`common.js` → engines → `plan-state.js`) is safe.

### B.2 Versioning & Migration

- `loadState` accepts any state with `v <= STATE_VERSION` and runs forward migrations. (Rev 1's strict `===` check contradicted the stated "old URLs still load" policy.)
- Unknown fields are ignored; missing fields are filled by `normalizeFullState`.
- A `MIGRATIONS = { 1: fn }` map registers per-version upgrades; bumping `STATE_VERSION` requires adding an entry plus a pipeline test.

### B.3 Compression (native, with format marker)

```js
// Output format: "<marker><base64url>", marker 'C' = deflate, 'R' = raw JSON.
// The marker lets older links survive a change in the compression path
// (rev 1 had no way to distinguish fallback payloads from compressed ones).

function bytesToBase64url(bytes) {
  let bin = '';
  const CHUNK = 0x8000; // rev 1 spread String.fromCharCode(...bytes) — stack
  for (let i = 0; i < bytes.length; i += CHUNK) {   // overflow on large arrays
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function compressState(obj) {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([new TextEncoder().encode(json)])
        .stream().pipeThrough(new CompressionStream('deflate'));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      return 'C' + bytesToBase64url(bytes);
    } catch (e) { /* fall through to raw */ }
  }
  return 'R' + bytesToBase64url(new TextEncoder().encode(json));
}

async function decompressState(str) {
  const marker = str[0];
  const b64 = str.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '==='.slice((b64.length + 3) % 4);
  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  if (marker === 'C') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()));
  }
  if (marker === 'R') return JSON.parse(new TextDecoder().decode(bytes));
  throw new Error('Unknown state format');
}
```

**Browser support:** `CompressionStream` shipped in Safari **16.4** (Mar 2022), Firefox 113, Chrome 80. Feature-detect (`typeof CompressionStream === 'function'`) — never version-sniff. The `'R'` path is the universal fallback; typical states stay well under URL limits either way.

**Node floor for tests:** `pipeline-tests.js` exercises the `'C'` path via the global `CompressionStream` — requires **Node ≥ 18**. Note this in the test header comment, alongside the existing zero-dependency convention.

### B.4 Load / Save (no top-level await, debounced hash writes)

```js
const STORAGE_KEY = 'financial-plan-state-v1';

// Pages keep synchronous-shaped init (repo pattern: fire-calculator.html:379-381).
// Classic scripts do not support top-level await, and converting pages to
// type="module" would break every inline onclick handler (module scope is
// not global — breaks the check-handlers.js contract).
PlanState.load().then(state => {
  window.state = state;
  syncInputsFromState(state);
  bindStaticInputs();
  recompute();
});

async function load(onError) {
  // 1. Hash (explicit share). Failures are SURFACED, never silently
  //    swallowed — a truncated link must show "This link couldn't be read",
  //    not plausible-looking defaults (rev 1 fell through silently).
  const m = (location.hash || '').match(/^#state=(.+)$/);
  if (m) {
    try {
      const parsed = await decompressState(decodeURIComponent(m[1]));
      if (parsed.v <= STATE_VERSION) return migrate(parsed);
      onError && onError('That link uses a newer plan format.');
    } catch (e) { onError && onError('This link couldn\'t be read.'); }
  }
  // 2. localStorage working copy
  // 3. Legacy migration (Part D only; non-destructive — see D.3)
  // 4. Defaults
  return defaultFullState();
}

let hashTimer = null;
function saveState(state, opts) {
  state.meta.lastEdited = Date.now();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { /* private mode */ }
  // Hash is written ONLY for opt-in share links (B.5), debounced 400ms so
  // rapid edits can't race async compression into out-of-order replaceState
  // calls (rev 1 fired compression per keystroke).
  if (opts && opts.updateHash) {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      compressState(state).then(s =>
        history.replaceState(null, '', '#state=' + encodeURIComponent(s)));
    }, 400);
  }
}
```

### B.5 Opt-In Share Links

Every page gets a **"Copy share link"** toolbar button (pattern: `retirement-calculator.html:741-766`, which already does copy-to-clipboard with address-bar fallback):

- Click → `compressState(currentState)` → `location.origin+path + '#state=' + encoded` → clipboard → status flash via `flashStatus()` (`fire-calculator.html:354-359`).
- `meta.created`/`meta.lastEdited` timestamps are stripped from the shared payload (fingerprinting surface).
- Nothing is written to the URL during normal editing.

**Why URLs are acceptable at all:** hash fragments are never sent in HTTP requests or `Referrer` headers, so no server sees the payload. Residual exposure is client-side: browser history, browser sync across a user's devices, screen shares, and paste mistakes. Opt-in + timestamp stripping + footer copy updates ("data leaves this device only when you create a share link") address these.

---

## Part C — Cross-Page Prefill (read-only handoff)

Before any shared writable state exists, pages gain "Continue to…" links that carry the current plan via the B.5 mechanism:

- Debt page: "Copy link for FIRE Calculator", "Copy link for Retirement Planner".
- FIRE page: "Copy link for Retirement Planner" (seeds `retirement.accounts.taxable` from projected balance and `spending.baseline` from `annualSpending` — mapped through `RetirementEngine.normalizeState`, which already deep-fills).
- Retirement page: keeps its existing `#data=` share links untouched (see D.4).

Receiving pages parse `#state=` via `PlanState.load()`, apply the prefill mapping, and show a dismissible banner: *"Loaded plan from another calculator — values are prefilled, edit freely."* Prefill never blocks editing and never re-applies after the banner is dismissed (hash is cleared via `history.replaceState(null, '', location.pathname)` once accepted or dismissed).

---

## Part D — True Unified State (gated, last)

Only after Part C proves the workflow: switch FIRE and retirement persistence from their per-page keys to `financial-plan-state-v1`, with pages writing only their own slice plus the shared age anchor.

### D.1 Landing Page — scoped down (resolves rev 1 contradiction)

Rev 1 promised a multi-plan manager ("last 5 plans") while specifying single-key storage; multi-plan was simultaneously deferred to Future Extensions. Rev 2 picks one: **single active plan**.

`index.html` gains:

- One "Current plan" summary card (debt total / FIRE number / retire age previews, computed by running each engine's pure functions over the stored slices — no duplicated math).
- Three entry links (existing `.calc-card` grid unchanged for the tracker).
- **Import / Export JSON**: download/upload the full unified state file; import runs `normalizeFullState` and shows a validation-error toast on failure.

Multi-plan/scenario naming stays in Future Extensions.

### D.2 Legacy Migration — corrected keys, non-destructive

Rev 1 read `'retirement-calculator-state-v1'`, which **does not exist** — the real key is `'retirementCalculator.v1'` (`retirement-calculator.html:346`). Corrected mapping:

```js
function migrateLegacyState() {
  const fireRaw = localStorage.getItem('fire-calculator-state-v1');   // fire-calculator.html:168
  const retireRaw = localStorage.getItem('retirementCalculator.v1');  // retirement-calculator.html:346
  if (!fireRaw && !retireRaw) return null;

  const state = defaultFullState();
  if (fireRaw) {
    const f = JSON.parse(fireRaw);            // { you, money, assumptions }
    state.fire = FireEngine.normalizeState(f);
    state.you.currentAge = state.fire.you.currentAge;
  }
  if (retireRaw) {
    const r = JSON.parse(retireRaw);
    state.retirement = RetirementEngine.normalizeState(r);  // verbatim shape — NOT "already matches"
    state.you.currentAge = state.retirement.you.currentAge;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}

  // NON-DESTRUCTIVE (rev 1 deleted legacy keys immediately — unrecoverable
  // if the mapping is buggy). Legacy keys are removed only after the user's
  // first successful edit writes the unified key.
  return state;
}
```

### D.3 Tab Conflicts

Last-write-wins, plus the mitigation rev 1 gestured at without specifying: a `window.addEventListener('storage', ...)` listener compares the incoming `meta.lastEdited` against the in-memory state and shows a "This plan changed in another tab — Reload / Keep mine" banner. Without the listener, tab A's stale memory silently overwrites tab B's edits on the next keystroke.

### D.4 Coexistence with Existing Retirement Features

- **Existing `#data=` share links** (`retirement-calculator.html:741`): remain fully supported. `PlanState.load()` only claims hashes matching `^#state=`; the retirement page's own loader continues to handle `#data=`. Both formats are documented in the page's share UI.
- **A/B scenarios** (`SCENARIO_KEY`, `retirement-calculator.html:347, 678-707`): scenarios snapshot whole retirement states. Restoring a slot writes through to `state.retirement` **and** calls `PlanState.saveState(...)` so the unified store doesn't silently revert the restore on next save.

---

## Security & Privacy

| Concern | Position |
|---|---|
| Referrer leakage | None — hash fragments are never transmitted to servers. Documented rationale for choosing `#` over query params. |
| Browser history / device sync | Mitigated by opt-in sharing only (B.5); no automatic URL writes. |
| Payload contents | Debt names, balances, ages are personal data. Timestamps stripped from shares; users are warned via footer copy before copying a link. |
| Footer / badge copy | Pages claiming "Private / on-device" gain "(unless you create a share link)" wherever the button exists. |
| Imported JSON | Treated as untrusted: `normalizeFullState` clamps everything; no `eval`/`Function`; debt names rendered via `esc()` (`common.js:41`) everywhere they hit innerHTML. |

---

## Test Files

### `scripts/debt-tests.js`
See A.8.

### `scripts/pipeline-tests.js`

Requires Node ≥ 18 (global `CompressionStream`). Stubs `localStorage`/`location`/`history` with plain objects before requiring `plan-state.js` (possible because the module touches DOM APIs only inside functions, never at load time).

Coverage:

- Unified round-trip: `compressState → decompressState → normalizeFullState` preserves all slices; equality asserted via `JSON.stringify`.
- Round-trip property cases: unicode/emoji debt names, empty debts, itemized spending arrays, near-ceiling payload sizes.
- Format markers: `'C'` payload decodes when `CompressionStream` present; `'R'` payload decodes regardless; unknown marker throws.
- Version handling: `v: 0`-style older states migrate forward; `v > STATE_VERSION` rejected with the error callback (not silent fall-through).
- Legacy migration: fixtures use the **real** legacy shapes — FIRE `{you, money, assumptions}` under `fire-calculator-state-v1`, retirement v2 (accounts-as-object) under `retirementCalculator.v1`; asserts legacy keys survive migration (D.2).
- Prefill mappings: debt→FIRE (budget×12 suggestion, integer `debtFreeAge`), FIRE→retirement (taxable seed, baseline spend) — each asserted through the receiving engine's `normalizeState` output.
- Debt engine integration: `payoffProjection` output feeds the FIRE prefill mapping end-to-end.

### Existing checks

`check-links.js` and `check-handlers.js` scan all root HTML automatically — no changes needed, but they now cover **5 HTML files** (including `index.html`). AGENTS.md checks list gains:

```sh
node scripts/debt-tests.js
node scripts/pipeline-tests.js
```

---

## Implementation Phases (revised)

### Phase 1: Debt Payoff Calculator (standalone)
1. `debt-engine.js` (UMD) + `scripts/debt-tests.js` including the closed-form cross-check.
2. `debt-calculator.html` using its own `STORAGE_KEY` and the standard page skeleton.
3. Run all checks. **Ship independently.**

### Phase 2: `plan-state.js` + opt-in prefill links
1. Add `plan-state.js` (schema, compression with markers, load/save, version policy).
2. Add "Copy share link" buttons and `#state=` loading to all three calculators; retirement keeps `#data=` support.
3. Landing page: Import/Export JSON + current-plan summary card.
4. `scripts/pipeline-tests.js`. Run all checks.

### Phase 3: Unified writable state (only if Phase 2 workflow proves useful)
1. Switch FIRE/retirement persistence to the unified key; wire the shared age anchor.
2. Non-destructive legacy migration (D.2); storage-event conflict banner (D.3); scenario write-through (D.4).
3. Update AGENTS.md checks list and README.

### Deferred (was Phase 3 in rev 1)
- Keyboard shortcuts, "fork plan" — reintroduce only with multi-plan support, since forking is meaningless with a single stored plan.

---

## File Inventory (final state)

```
calculators/
├── index.html                    # Entry links + import/export + current-plan summary (updated)
├── fire-calculator.html          # + share-link button, #state= loader (updated)
├── retirement-calculator.html    # + share-link button; keeps #data= loader (updated)
├── debt-calculator.html          # NEW
├── shared.css                    # Unchanged (debt page reuses .bar/.card/.segmented)
├── common.js                     # Unchanged (stays DOM-only helpers)
├── plan-state.js                 # NEW — UMD state/migration/compression module
├── fire-engine.js                # Unchanged
├── retirement-engine.js          # Unchanged (normalizeState already deep-fills; no adapter needed)
├── debt-engine.js                # NEW
├── cloud-client.js               # Unchanged
├── tracker-engine.js             # Unchanged
├── group-expense-tracker.html    # Unchanged
├── scripts/
│   ├── check-links.js            # Unchanged (auto-discovers HTML)
│   ├── check-handlers.js         # Unchanged
│   ├── retirement-tests.js       # Unchanged
│   ├── cloud-client-tests.js     # Unchanged
│   ├── fire-tests.js             # Unchanged
│   ├── debt-tests.js             # NEW
│   └── pipeline-tests.js         # NEW (Node ≥ 18)
├── worker/                       # Unchanged
└── docs/
    └── workflow-and-payoff.md    # THIS FILE
```

---

## Acceptance Criteria

- [ ] All existing tests pass (`fire-tests.js`, `retirement-tests.js`, `cloud-client-tests.js`)
- [ ] `debt-tests.js`: 20+ tests passing, including the amortization closed-form cross-check
- [ ] `pipeline-tests.js`: 10+ tests passing, including compression round-trip (both format markers) and legacy-migration fixtures using the real key names and shapes
- [ ] `check-links.js` / `check-handlers.js` pass across all 5 root HTML files
- [ ] Debt page: standalone persistence, strategy comparison, unpayable-debt flag, custom-order reorder controls
- [ ] Editing does **not** modify the URL; "Copy share link" produces a working `#state=` link; a corrupted link shows an explicit error, never silent defaults
- [ ] Opening a share link prefills the receiving page with a dismissible banner; dismissing clears the hash
- [ ] Legacy migration finds `fire-calculator-state-v1` **and** `retirementCalculator.v1`, preserves the original keys, and is idempotent
- [ ] Retirement `#data=` share links and A/B scenario restores continue to work unchanged (scenario restores write through to the unified store)
- [ ] No build step, no dependencies added; all new logic Node-testable via UMD modules

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| URL length limits (~2KB practical) | Deflate + base64url keeps typical states small; `'R'` raw fallback for oversized/no-CompressionStream cases; import/export JSON as the unlimited path |
| `CompressionStream` availability | Feature-detect (`typeof CompressionStream === 'function'`); Safari 16.4+/Firefox 113+/Chrome 80; `'R'` marker keeps old links decodable if the path changes |
| Two tabs editing one plan | Last-write-wins + `storage` event banner with explicit Reload/Keep-mine choice (D.3) |
| Schema evolution | `v` field, accept `v ≤ STATE_VERSION`, registered `MIGRATIONS` map, pipeline-tested |
| Migration data loss | Non-destructive: legacy keys retained until first unified write (D.2) |
| Regressions in retirement page (scenarios, CSV, Monte Carlo) | Phase 3 gating: unified persistence lands only after read-only prefill proves stable; scenarios write-through covered by pipeline tests |
| Inline-handler breakage during init changes | No top-level await, no ES modules; async init wrapped in `PlanState.load().then(...)` keeping handlers top-level globals (check-handlers.js contract) |

---

## Future Extensions (Out of Scope)

- **Multiple named plans** — `{ id, name, state }[]` in localStorage; prerequisite for meaningful "fork plan" and scenario naming.
- **Debt-aware FIRE timeline** — model a "no savings until debt-free age X" ramp instead of the flat budget×12 prefill.
- **Tax-aware debt payoff** — student-loan/mortgage interest deductions (complex, low ROI).
- **Monte Carlo toggle in FIRE calculator** — reuse retirement planner's engine.

---

*Rev 2 changes: schema now derives verbatim from engine `defaultState()` outputs; state logic moved to UMD `plan-state.js`; URL sharing made opt-in with format markers and explicit error UI; debt algorithm fixes (budget semantics, mid-month redistribution, payable flag, epsilon, clamp ranges); corrected legacy key names and non-destructive migration; reconciled retirement `#data=` links and A/B scenarios; landing page scoped to single active plan; phases reordered to ship the debt calculator first.*
