/*
 * Unified plan state container shared by the calculator pages.
 *
 * Versioned schema whose engine slices are the engines' verbatim
 * defaultState() outputs — no adapters. Provides opt-in URL sharing
 * (#state=…, deflate-compressed with a format marker), localStorage
 * persistence for the unified store, forward migrations, and the pure
 * cross-page prefill mappings. UMD footer exposes `window.PlanState` in
 * the browser and `module.exports` in Node. No ES module syntax anywhere:
 * pages load classic scripts and rely on globals for inline handlers.
 *
 * Engine globals are resolved lazily inside functions, so load order
 * (common.js → engines → plan-state.js) is safe, and Node tests can
 * simply require this file after stubbing browser globals.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlanState = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATE_VERSION = 1;
  const STORAGE_KEY = 'financial-plan-state-v1';

  // ---- lazy engine resolution ------------------------------------------------

  function getEngines() {
    const hasRequire = typeof require === 'function';
    const g = typeof self !== 'undefined' ? self : globalThis;
    const pick = (globalName, relPath) =>
      g[globalName] || (hasRequire ? require(relPath) : null);
    return {
      Fire: pick('FireEngine', './fire-engine.js'),
      Retirement: pick('RetirementEngine', './retirement-engine.js'),
      Debt: pick('DebtEngine', './debt-engine.js')
    };
  }

  // ---- unified schema --------------------------------------------------------

  function defaultFullState() {
    const { Fire, Retirement } = getEngines();
    return {
      v: STATE_VERSION,
      meta: { created: Date.now(), lastEdited: Date.now(), origin: null },
      you: { currentAge: 35 }, // shared age anchor
      debts: [],
      debtStrategy: 'avalanche',
      monthlyDebtBudget: 0,
      fire: Fire ? Fire.defaultState() : undefined,
      retirement: Retirement ? Retirement.defaultState() : undefined
    };
  }

  function clampInt(v, lo, hi, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  // Verbatim engine normalization — no adapters. Unknown fields ignored,
  // missing fields filled from each engine's own defaults.
  function normalizeFullState(s) {
    const { Debt } = getEngines();
    const out = defaultFullState();
    const src = s && typeof s === 'object' ? s : {};
    if (src.you && Number.isFinite(Number(src.you.currentAge))) {
      out.you.currentAge = clampInt(src.you.currentAge, 0, 120, out.you.currentAge);
    }
    if (src.fire && out.fire) out.fire = getEngines().Fire.normalizeState(src.fire);
    if (src.retirement && out.retirement) out.retirement = getEngines().Retirement.normalizeState(src.retirement);
    if (Array.isArray(src.debts) && Debt) {
      out.debts = src.debts.map((d, i) => Debt.normalizeDebt(d, i));
    }
    if (typeof src.debtStrategy === 'string') {
      out.debtStrategy = ['avalanche', 'snowball', 'custom'].includes(src.debtStrategy)
        ? src.debtStrategy : 'avalanche';
    }
    if (src.monthlyDebtBudget != null) {
      const n = Number(src.monthlyDebtBudget);
      out.monthlyDebtBudget = Number.isFinite(n) ? Math.max(0, n) : 0;
    }
    return out;
  }

  // ---- versioning & migration ------------------------------------------------

  // Register per-version upgrades here; bumping STATE_VERSION requires an
  // entry plus a pipeline test.
  const MIGRATIONS = {
    // 0: pre-release states without a v field — nothing structural changed,
    // normalizeFullState fills everything; bump the marker only.
    0: function (s) { return { ...s, v: 1 }; }
  };

  function migrate(state) {
    let s = state && typeof state === 'object' ? state : {};
    let guard = 0;
    while (Number(s.v) < STATE_VERSION && guard++ < 16) {
      const step = MIGRATIONS[Number(s.v)];
      s = step ? step(s) : { ...s, v: Number(s.v) + 1 };
    }
    return normalizeFullState(s);
  }

  // ---- compression (native, with format marker) ------------------------------
  //
  // Output format: "<marker><base64url>", marker 'C' = deflate, 'R' = raw
  // JSON. The marker lets older links survive a change in the compression
  // path. Feature-detect CompressionStream — never version-sniff.

  function bytesToBase64url(bytes) {
    let bin = '';
    const CHUNK = 0x8000; // chunked: spreading huge arrays overflows the stack
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64urlToBytes(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
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
    const bytes = base64urlToBytes(str.slice(1));
    if (marker === 'C') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      return JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()));
    }
    if (marker === 'R') return JSON.parse(new TextDecoder().decode(bytes));
    throw new Error('Unknown state format');
  }

  // ---- load / save -----------------------------------------------------------

  function stateHashValue() {
    const m = (typeof location !== 'undefined' ? location.hash || '' : '').match(/^#state=(.+)$/);
    return m ? m[1] : null;
  }

  function clearStateHash() {
    if (typeof history === 'undefined' || !stateHashValue()) return;
    history.replaceState(null, '', location.pathname + location.search);
  }

  async function decodeHashPayload(onError) {
    const enc = stateHashValue();
    if (!enc) return null;
    try {
      const parsed = await decompressState(decodeURIComponent(enc));
      if (parsed && typeof parsed === 'object' && Number(parsed.v) <= STATE_VERSION) {
        return migrate(parsed);
      }
      if (onError) onError('That link uses a newer plan format.');
    } catch (e) {
      if (onError) onError("This link couldn't be read.");
    }
    return null;
  }

  // Hash-only parse for receiving pages (never touches localStorage).
  async function readSharedState(onError) {
    return decodeHashPayload(onError);
  }

  // Full loader: explicit share hash → localStorage working copy → legacy
  // migration → defaults. Hash failures are SURFACED via onError, never
  // silently swallowed into plausible-looking defaults.
  async function load(onError) {
    const shared = await decodeHashPayload(onError);
    if (shared) return shared;

    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) return normalizeFullState(JSON.parse(raw));
    } catch (e) { /* corrupted storage falls through */ }

    const legacy = migrateLegacyState();
    if (legacy) return legacy;

    return defaultFullState();
  }

  let hashTimer = null;
  function saveState(state, opts) {
    state.meta.lastEdited = Date.now();
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch (e) { /* private mode */ }
    // Hash is written ONLY for opt-in share links, debounced so rapid edits
    // cannot race async compression into out-of-order replaceState calls.
    if (opts && opts.updateHash) {
      if (typeof clearTimeout === 'function') clearTimeout(hashTimer);
      hashTimer = setTimeout(() => {
        compressState(state).then(s => {
          if (typeof history !== 'undefined') {
            history.replaceState(null, '', '#state=' + encodeURIComponent(s));
          }
        }).catch(() => {});
      }, 400);
    }
  }

  // ---- opt-in share links ----------------------------------------------------

  // meta.created/lastEdited are stripped from the shared payload
  // (fingerprinting surface).
  async function encodeSharePayload(fullState) {
    const copy = JSON.parse(JSON.stringify(fullState));
    delete copy.meta;
    return compressState(copy);
  }

  // page: optional target file name ('fire-calculator.html'); empty string
  // means the current page.
  async function buildShareUrl(fullState, page) {
    const payload = await encodeSharePayload(fullState);
    if (typeof location === 'undefined') return '#state=' + encodeURIComponent(payload);
    const u = new URL(page || '', location.href);
    return u.origin + u.pathname + '#state=' + encodeURIComponent(payload);
  }

  // Assemble a shareable full state from whatever slices a page holds.
  function buildFullState(parts) {
    const full = defaultFullState();
    const p = parts || {};
    if (p.origin) full.meta.origin = p.origin;
    if (p.you && Number.isFinite(Number(p.you.currentAge))) {
      full.you.currentAge = clampInt(p.you.currentAge, 0, 120, full.you.currentAge);
    }
    if (p.debts) {
      full.debts = p.debts;
      full.debtStrategy = p.debtStrategy || full.debtStrategy;
      full.monthlyDebtBudget = p.monthlyDebtBudget != null ? p.monthlyDebtBudget : full.monthlyDebtBudget;
    }
    if (p.fire) full.fire = p.fire;
    if (p.retirement) full.retirement = p.retirement;
    return normalizeFullState(full);
  }

  // ---- legacy migration (non-destructive) ------------------------------------
  //
  // Reads the real per-page keys, maps them into the unified schema, writes
  // the unified key, and KEEPS the legacy keys — they are removed only after
  // the user's first successful edit writes the unified key elsewhere.

  function migrateLegacyState() {
    if (typeof localStorage === 'undefined') return null;
    const { Fire, Retirement } = getEngines();
    let fireRaw = null, retireRaw = null;
    try {
      fireRaw = localStorage.getItem('fire-calculator-state-v1');
      retireRaw = localStorage.getItem('retirementCalculator.v1');
    } catch (e) { return null; }
    if (!fireRaw && !retireRaw) return null;

    const state = defaultFullState();
    try {
      if (fireRaw && Fire) {
        const f = JSON.parse(fireRaw); // { you, money, assumptions }
        state.fire = Fire.normalizeState(f);
        state.you.currentAge = state.fire.you.currentAge;
      }
      if (retireRaw && Retirement) {
        const r = JSON.parse(retireRaw);
        state.retirement = Retirement.normalizeState(r); // verbatim shape
        state.you.currentAge = state.retirement.you.currentAge;
      }
    } catch (e) { return null; }

    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    return state;
  }

  // ---- cross-page prefill mappings (pure, Node-testable) ---------------------

  // Debt plan → FIRE slice: suggests annualSavings = budget × 12 (valid FROM
  // debt freedom) and computes the integer debt-free age for the banner.
  function prefillFireFromDebt(full) {
    const { Debt, Fire } = getEngines();
    const debtState = Debt.normalizeState({
      debts: full.debts,
      monthlyDebtBudget: full.monthlyDebtBudget,
      debtStrategy: full.debtStrategy
    });
    const proj = Debt.payoffProjection(debtState);
    const fireInput = full.fire
      ? JSON.parse(JSON.stringify(full.fire))
      : Fire.defaultState();
    if (proj.payable && proj.months > 0 && full.monthlyDebtBudget > 0) {
      fireInput.money = fireInput.money || {};
      fireInput.money.annualSavings = full.monthlyDebtBudget * 12;
    }
    if (full.you && Number.isFinite(Number(full.you.currentAge))) {
      fireInput.you = Object.assign({}, fireInput.you, { currentAge: full.you.currentAge });
    }
    const fire = Fire.normalizeState(fireInput);
    const debtFreeAge = proj.payable && proj.months != null &&
        full.you && Number.isFinite(Number(full.you.currentAge))
      ? Math.ceil(full.you.currentAge + proj.months / 12)
      : null;
    return { fire, debtFreeAge, annualInvesting: Math.max(0, full.monthlyDebtBudget) * 12, months: proj.months };
  }

  // FIRE slice → retirement slice: seeds taxable from the projected balance
  // at FIRE target age and baseline spending from the FIRE annual spending.
  function prefillRetirementFromFire(full) {
    const { Fire, Retirement } = getEngines();
    const fire = Fire.normalizeState(full.fire || Fire.defaultState());
    const retInput = full.retirement
      ? JSON.parse(JSON.stringify(full.retirement))
      : Retirement.defaultState();
    const projected = Fire.coastNumber(fire).projectedBalance;
    retInput.accounts = retInput.accounts || {};
    retInput.accounts.taxable = Math.max(0, Math.round(projected));
    retInput.spending = retInput.spending || {};
    retInput.spending.baseline = Math.max(0, Fire.annualSpendingFor(fire));
    if (fire.you && Number.isFinite(Number(fire.you.currentAge))) {
      retInput.you = Object.assign({}, retInput.you, { currentAge: fire.you.currentAge });
    }
    return { retirement: Retirement.normalizeState(retInput), projectedBalance: projected };
  }

  return {
    // schema & migration
    STATE_VERSION, STORAGE_KEY,
    defaultFullState, normalizeFullState, migrate, MIGRATIONS, migrateLegacyState,
    // compression
    compressState, decompressState, bytesToBase64url, base64urlToBytes,
    // load / save / share
    load, saveState, readSharedState, clearStateHash, stateHashValue,
    encodeSharePayload, buildShareUrl, buildFullState,
    // prefill mappings
    prefillFireFromDebt, prefillRetirementFromFire
  };
}));
