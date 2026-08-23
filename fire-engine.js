/*
 * FIRE calculator engine.
 *
 * Pure, DOM-free calculation core shared by fire-calculator.html (browser)
 * and scripts/fire-tests.js (Node). No dependencies. UMD footer exposes it
 * as `window.FireEngine` in the browser and `module.exports` in Node.
 *
 * All math runs in real (today's-dollar) terms: the nominal return is
 * converted to a real return using the inflation input, so every result —
 * the FIRE number, the Coast number, the timeline — is expressed in today's
 * dollars. Everything here is deterministic given its inputs, so the whole
 * engine is unit-testable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FireEngine = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- defaults ------------------------------------------------------------

  const MAX_YEARS = 80; // projection cap; beyond this the path is flagged unreachable

  function defaultState() {
    return {
      v: 1,
      you: { currentAge: 35, targetAge: 65 },
      money: {
        annualSpending: 60000, // desired yearly living expenses, today's dollars, after tax
        currentBalance: 200000,
        annualSavings: 24000
      },
      assumptions: {
        withdrawalRate: 0.04, // safe withdrawal rate (4% rule)
        taxRate: 0.15,        // effective rate owed on retirement withdrawals
        nominalReturn: 0.08,
        inflation: 0.03
      }
    };
  }

  function sampleState() {
    const s = defaultState();
    s.you = { currentAge: 32, targetAge: 60 };
    s.money = { annualSpending: 48000, currentBalance: 200000, annualSavings: 30000 };
    s.assumptions = { withdrawalRate: 0.035, taxRate: 0.18, nominalReturn: 0.07, inflation: 0.025 };
    return s;
  }

  // ---- helpers -------------------------------------------------------------

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function clampInt(v, lo, hi, fallback) {
    const n = Math.round(num(v, fallback));
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  }

  // Deep-fill a partial/loaded state against the defaults so the engine never
  // hits an undefined field. Coerces and clamps numeric fields.
  function normalizeState(input) {
    const d = defaultState();
    const s = input && typeof input === 'object' ? input : {};
    const out = defaultState();

    if (s.you) {
      out.you.currentAge = clampInt(s.you.currentAge, 0, 100, d.you.currentAge);
      out.you.targetAge = clampInt(s.you.targetAge, 0, 120, d.you.targetAge);
    }
    if (s.money) {
      out.money.annualSpending = Math.max(0, num(s.money.annualSpending, d.money.annualSpending));
      out.money.currentBalance = Math.max(0, num(s.money.currentBalance, d.money.currentBalance));
      out.money.annualSavings = Math.max(0, num(s.money.annualSavings, d.money.annualSavings));
    }
    if (s.assumptions) {
      const a = s.assumptions;
      out.assumptions.withdrawalRate = clamp(num(a.withdrawalRate, d.assumptions.withdrawalRate), 0.005, 0.5);
      out.assumptions.taxRate = clamp(num(a.taxRate, d.assumptions.taxRate), 0, 0.9);
      out.assumptions.nominalReturn = clamp(num(a.nominalReturn, d.assumptions.nominalReturn), -0.9, 0.5);
      out.assumptions.inflation = clamp(num(a.inflation, d.assumptions.inflation), -0.5, 0.5);
    }
    return out;
  }

  // Non-fatal warnings for the UI; normalization already prevents invalid math.
  function validate(state) {
    const s = normalizeState(state);
    const issues = [];
    if (s.you.targetAge <= s.you.currentAge) {
      issues.push('Target age is not after your current age — the Coast number equals the FIRE number.');
    }
    if (s.money.annualSavings <= 0 && s.money.currentBalance < fireNumber(s).fireNumber) {
      issues.push('With no savings added each year, the timeline only reflects investment growth.');
    }
    if (realReturn(s) <= 0) {
      issues.push('Real return is zero or negative — money loses ground to inflation under these assumptions.');
    }
    return issues;
  }

  // ---- core calculations ---------------------------------------------------

  // Nominal return converted to real (inflation-adjusted) return.
  function realReturn(state) {
    const s = normalizeState(state);
    return (1 + s.assumptions.nominalReturn) / (1 + s.assumptions.inflation) - 1;
  }

  // Question 1: how big must the portfolio be?
  // Withdrawals must cover after-tax spending plus the tax owed on the
  // withdrawal itself, then the safe withdrawal rate converts that yearly
  // draw into a required nest egg.
  function fireNumber(state) {
    const s = normalizeState(state);
    const grossWithdrawal = s.assumptions.taxRate < 1
      ? s.money.annualSpending / (1 - s.assumptions.taxRate)
      : Infinity;
    const fireNum = grossWithdrawal / s.assumptions.withdrawalRate;
    return {
      annualSpending: s.money.annualSpending,
      taxRate: s.assumptions.taxRate,
      grossWithdrawal,
      withdrawalRate: s.assumptions.withdrawalRate,
      fireNumber: fireNum,
      spendingMultiple: s.money.annualSpending > 0 ? fireNum / s.money.annualSpending : 0
    };
  }

  // Question 2: how much invested today grows into the FIRE number by the
  // target age with no further contributions — and what does the current
  // balance actually become along the way?
  function coastNumber(state) {
    const s = normalizeState(state);
    const fn = fireNumber(s).fireNumber;
    const r = realReturn(s);
    const years = Math.max(0, s.you.targetAge - s.you.currentAge);
    const growthFactor = Math.pow(1 + r, years);
    const coastNum = fn / growthFactor;
    const projectedBalance = s.money.currentBalance * growthFactor;
    return {
      years,
      realReturn: r,
      growthFactor,
      fireNumber: fn,
      coastNumber: coastNum,
      projectedBalance,
      coastProgress: coastNum > 0 ? s.money.currentBalance / coastNum : 1,
      onTrack: s.money.currentBalance >= coastNum
    };
  }

  // Question 3: on the current trajectory (balance growing at the real return
  // plus end-of-year contributions), when does the portfolio cross the FIRE
  // number? Iterated year by year so the schedule doubles as the progress view.
  function yearsToFi(state) {
    const s = normalizeState(state);
    const fn = fireNumber(s).fireNumber;
    const r = realReturn(s);
    const schedule = [];

    if (s.money.currentBalance >= fn) {
      return { years: 0, fiAge: s.you.currentAge, reachable: true, schedule };
    }

    let bal = s.money.currentBalance;
    for (let year = 1; year <= MAX_YEARS; year++) {
      const startBalance = bal;
      const growth = bal * r;
      bal = bal + growth + s.money.annualSavings;
      schedule.push({
        year,
        age: s.you.currentAge + year,
        startBalance,
        growth,
        contribution: s.money.annualSavings,
        endBalance: bal,
        progress: fn > 0 ? bal / fn : 1
      });
      if (bal >= fn) {
        return { years: year, fiAge: s.you.currentAge + year, reachable: true, schedule };
      }
    }
    return { years: null, fiAge: null, reachable: false, schedule };
  }

  // Convenience wrapper: everything the UI needs from one state object.
  function fullProjection(state) {
    const s = normalizeState(state);
    return {
      state: s,
      realReturn: realReturn(s),
      fire: fireNumber(s),
      coast: coastNumber(s),
      timeline: yearsToFi(s),
      issues: validate(s)
    };
  }

  return {
    // state
    defaultState, sampleState, normalizeState, validate,
    // primitives (exported for testing)
    realReturn, fireNumber, coastNumber, yearsToFi,
    // combined
    fullProjection,
    // constants
    MAX_YEARS
  };
}));
