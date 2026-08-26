/*
 * Debt payoff calculator engine.
 *
 * Pure, DOM-free calculation core shared by debt-calculator.html (browser)
 * and scripts/debt-tests.js (Node). No dependencies. UMD footer exposes it
 * as `window.DebtEngine` in the browser and `module.exports` in Node.
 *
 * The projection walks month by month: interest accrues on every active
 * debt first, then minimums are paid (always, even past the budget —
 * missed minimums mean default), then the leftover budget rolls through
 * extra targets in strategy order until it is exhausted. Everything here
 * is deterministic given its inputs, so the whole engine is unit-testable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DebtEngine = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- constants ------------------------------------------------------------

  const MAX_MONTHS = 600;      // 50-year cap; beyond this the plan is flagged unpayable
  const PAYOFF_EPSILON = 0.01; // balances at/below this count as paid

  // ---- defaults -------------------------------------------------------------

  function defaultState() {
    return {
      v: 1,
      you: { currentAge: null }, // optional; only used for the derived FIRE link line
      debts: [],                 // { name, balance, apr, minPayment }
      monthlyDebtBudget: 0,
      debtStrategy: 'avalanche'  // 'avalanche' | 'snowball' | 'custom'
    };
  }

  function sampleState() {
    const s = defaultState();
    s.you = { currentAge: 35 };
    s.debts = [
      { name: 'Credit card', balance: 12000, apr: 0.24, minPayment: 300 },
      { name: 'Car loan', balance: 15000, apr: 0.07, minPayment: 380 },
      { name: 'Student loan', balance: 22000, apr: 0.055, minPayment: 350 }
    ];
    s.monthlyDebtBudget = 2500;
    s.debtStrategy = 'avalanche';
    return s;
  }

  // ---- helpers --------------------------------------------------------------

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // Malformed entries become empty placeholder rows (mirrors normalizeItem in
  // fire-engine.js).
  function normalizeDebt(d, i) {
    d = d && typeof d === 'object' ? d : {};
    return {
      name: String(d.name == null || d.name === '' ? ('Debt ' + (i + 1)) : d.name),
      balance: Math.max(0, num(d.balance, 0)),
      apr: clamp(num(d.apr, 0), 0, 1),
      minPayment: Math.max(0, num(d.minPayment, 0))
    };
  }

  function normalizeState(input) {
    const s = input && typeof input === 'object' ? input : {};
    const out = defaultState();
    if (s.you && Number.isFinite(Number(s.you.currentAge))) {
      out.you.currentAge = clamp(Math.round(num(s.you.currentAge, 0)), 0, 120);
    }
    out.debts = Array.isArray(s.debts) ? s.debts.map(normalizeDebt) : [];
    out.monthlyDebtBudget = Math.max(0, num(s.monthlyDebtBudget, 0));
    out.debtStrategy = s.debtStrategy === 'snowball' || s.debtStrategy === 'custom'
      ? s.debtStrategy
      : 'avalanche';
    return out;
  }

  // Non-fatal warnings for the UI; normalization already prevents invalid math.
  function validate(state) {
    const s = normalizeState(state);
    const issues = [];
    if (s.debts.length === 0) {
      issues.push('No debts yet — add one to see a payoff plan.');
    }
    const active = s.debts.filter(d => d.balance > PAYOFF_EPSILON);
    const minTotal = active.reduce((sum, d) => sum + d.minPayment, 0);
    if (active.length && s.monthlyDebtBudget < minTotal) {
      issues.push('Monthly budget is below the sum of minimum payments (' + fmtMoney(minTotal) +
        '). Minimums are always paid in full — the budget caps extra payments only.');
    }
    active.forEach(d => {
      if (d.minPayment <= d.balance * (d.apr / 12)) {
        issues.push('“' + d.name + '”: the minimum payment does not cover the monthly interest, so the balance grows every month.');
      }
    });
    if (active.length && !payoffProjection(s).payable) {
      issues.push('This plan does not pay off within ' + Math.round(MAX_MONTHS / 12) +
        ' years — raise the budget or the minimum payments.');
    }
    return issues;
  }

  function fmtMoney(n) {
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function addMonths(date, months) {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
  }

  // ---- strategy orders (operate on ACTIVE debts only) -----------------------

  // Highest APR first.
  function avalancheOrder(activeDebts) {
    return activeDebts.slice().sort((a, b) => b.apr - a.apr)[0] || null;
  }

  // Lowest balance first.
  function snowballOrder(activeDebts) {
    return activeDebts.slice().sort((a, b) => a.balance - b.balance)[0] || null;
  }

  // Custom: stored debts[] array order (UI provides ▲/▼ reorder buttons).
  function customOrder(activeDebts) {
    return activeDebts[0] || null;
  }

  function orderFor(strategy) {
    if (strategy === 'snowball') return snowballOrder;
    if (strategy === 'custom') return customOrder;
    return avalancheOrder;
  }

  // ---- core algorithm -------------------------------------------------------
  //
  // Locked conventions (each covered by a named test in scripts/debt-tests.js):
  // 1. Minimums always get paid; budget caps extras only.
  // 2. Interest accrues before payments.
  // 3. Freed minimums flow into extra payments automatically.
  // 4. Leftover budget redistributes to the next target within the same month.
  // 5. Balances at/below PAYOFF_EPSILON are settled; no infinite float loops.

  function runStrategy(state, orderFn) {
    const s = normalizeState(state);
    const debts = s.debts.map(d => ({ ...d, interest: 0, payment: 0 }));
    const schedule = [];
    let month = 0;

    const active = list => list.filter(d => d.balance > PAYOFF_EPSILON);

    while (active(debts).length && month < MAX_MONTHS) {
      month++;

      // 1. Accrue interest on all active debts (interest-before-payment).
      debts.forEach(d => {
        if (d.balance <= PAYOFF_EPSILON) return;
        d.interest = d.balance * (d.apr / 12);
        d.balance += d.interest;
      });

      // 2. Pay minimums in full, even past the budget.
      let remaining = s.monthlyDebtBudget;
      debts.forEach(d => {
        if (d.balance <= PAYOFF_EPSILON) return;
        const pay = Math.min(d.minPayment, d.balance);
        d.balance -= pay;
        remaining -= pay;
        d.payment += pay;
      });

      // 3. Extra payments roll through targets in strategy order until the
      //    budget is exhausted (leftover redistributes within the same month).
      let target = orderFn(active(debts));
      while (target && remaining > PAYOFF_EPSILON) {
        const pay = Math.min(remaining, target.balance);
        target.balance -= pay;
        target.payment += pay;
        remaining -= pay;
        target = orderFn(active(debts));
      }

      // 4. Snapshot.
      schedule.push({
        month,
        debts: debts.map(d => ({
          name: d.name,
          balance: Math.max(0, d.balance),
          interest: d.interest,
          payment: d.payment
        })),
        totalBalance: debts.reduce((sum, d) => sum + Math.max(0, d.balance), 0),
        totalInterest: debts.reduce((sum, d) => sum + d.interest, 0),
        remainingBudget: Math.max(0, remaining)
      });
      debts.forEach(d => { d.interest = 0; d.payment = 0; });
    }

    const payable = active(debts).length === 0;
    return {
      months: payable ? month : null,
      payable,
      totalInterest: schedule.reduce((sum, r) => sum + r.totalInterest, 0),
      debtFreeDate: payable ? addMonths(new Date(), month) : null,
      schedule
    };
  }

  // Selected strategy → full result.
  function payoffProjection(state) {
    const s = normalizeState(state);
    return runStrategy(s, orderFor(s.debtStrategy));
  }

  // Both strategies on identical normalized inputs, plus what avalanche saves.
  function compareStrategies(state) {
    const s = normalizeState(state);
    const avalanche = runStrategy(s, avalancheOrder);
    const snowball = runStrategy(s, snowballOrder);
    return {
      avalanche,
      snowball,
      savings: {
        interest: snowball.totalInterest - avalanche.totalInterest,
        months: snowball.months != null && avalanche.months != null
          ? snowball.months - avalanche.months
          : null
      }
    };
  }

  // Convenience wrapper: everything the UI needs from one state object.
  function fullProjection(state) {
    const s = normalizeState(state);
    return {
      state: s,
      result: payoffProjection(s),
      comparison: compareStrategies(s),
      issues: validate(s)
    };
  }

  return {
    // state
    defaultState, sampleState, normalizeState, validate, normalizeDebt,
    // primitives (exported for testing)
    runStrategy, avalancheOrder, snowballOrder, customOrder, orderFor, addMonths,
    // combined
    payoffProjection, compareStrategies, fullProjection,
    // constants
    MAX_MONTHS, PAYOFF_EPSILON
  };
}));
