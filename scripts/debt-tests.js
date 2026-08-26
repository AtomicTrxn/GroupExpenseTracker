#!/usr/bin/env node
/*
 * Automated tests for the debt payoff calculator engine.
 *
 * Zero-dependency, matching the repo's plain-node convention (see
 * scripts/fire-tests.js). Run with:  node scripts/debt-tests.js
 * Exits non-zero if any assertion fails.
 */
const path = require('path');
const E = require(path.join(__dirname, '..', 'debt-engine.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function approx(actual, expected, tol, msg) {
  tol = tol == null ? 1e-6 : tol;
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg || 'approx'}: expected ${expected}, got ${actual} (tol ${tol})`);
  }
}

// Mixed-APR fixture used across strategy tests.
function mixedFixture() {
  return {
    v: 1,
    you: { currentAge: 35 },
    debts: [
      { name: 'Card', balance: 10000, apr: 0.24, minPayment: 250 },
      { name: 'Car', balance: 8000, apr: 0.07, minPayment: 200 },
      { name: 'Loan', balance: 5000, apr: 0.12, minPayment: 150 }
    ],
    monthlyDebtBudget: 1200,
    debtStrategy: 'avalanche'
  };
}

// ---- closed-form cross-check ------------------------------------------------

test('closed form cross-check: single debt matches n = -ln(1 - rB/P)/ln(1+r)', () => {
  const B = 12000, P = 400, apr = 0.18;
  const r = apr / 12;
  const closed = -Math.log(1 - r * B / P) / Math.log(1 + r);
  const s = E.defaultState();
  s.debts = [{ name: 'Only', balance: B, apr, minPayment: 100 }];
  s.monthlyDebtBudget = P;
  const res = E.payoffProjection(s);
  assert(res.payable === true);
  // iteration reports the first whole month-end at/below the epsilon
  assert(Math.ceil(closed - 1e-9) === res.months, `ceil(${closed}) vs ${res.months}`);
  approx(res.months, closed, 1);
});

test('closed form: zero APR is a plain division', () => {
  const s = E.defaultState();
  s.debts = [{ name: 'Free', balance: 4800, apr: 0, minPayment: 0 }];
  s.monthlyDebtBudget = 400;
  const res = E.payoffProjection(s);
  approx(res.months, 12);
});

// ---- strategy comparison ----------------------------------------------------

test('avalanche minimizes total interest vs snowball on a mixed-APR fixture', () => {
  const c = E.compareStrategies(mixedFixture());
  assert(c.avalanche.totalInterest < c.snowball.totalInterest,
    `avalanche ${c.avalanche.totalInterest} should beat snowball ${c.snowball.totalInterest}`);
  assert(c.savings.interest > 0);
});

test('snowball clears its first debt sooner on the same fixture', () => {
  const f = mixedFixture();
  const av = E.runStrategy(f, E.avalancheOrder);
  const sn = E.runStrategy(f, E.snowballOrder);
  // first payoff month = first snapshot where some balance hits zero
  const firstPayoff = sched => sched.findIndex(row => row.debts.some(d => d.balance <= E.PAYOFF_EPSILON));
  const avFirst = firstPayoff(av.schedule), snFirst = firstPayoff(sn.schedule);
  assert(snFirst > 0 && avFirst > 0);
  assert(snFirst < avFirst, `snowball first payoff month ${snFirst} should precede avalanche ${avFirst}`);
});

test('compareStrategies runs both strategies on identical normalized inputs', () => {
  const c = E.compareStrategies({ debts: [{ balance: 1000, apr: null, minPayment: 50 }], monthlyDebtBudget: -5 });
  assert(c.avalanche && c.snowball);
  assert(Array.isArray(c.avalanche.schedule) && Array.isArray(c.snowball.schedule));
  // both saw the same normalized single debt
  approx(c.avalanche.schedule[0].debts[0].balance, c.snowball.schedule[0].debts[0].balance);
});

// ---- locked conventions -----------------------------------------------------

test('minimum-payment roll-over: freed minimums reach the next target the same month', () => {
  // Two zero-APR debts; budget far above minimums. When debt A clears via its
  // minimum + extra, its freed minimum must land on B within that same month.
  const s = E.defaultState();
  s.debts = [
    { name: 'A', balance: 300, apr: 0, minPayment: 100 },
    { name: 'B', balance: 1000, apr: 0, minPayment: 100 }
  ];
  s.monthlyDebtBudget = 600;
  const res = E.runStrategy(s, E.customOrder);
  const m1 = res.schedule[0];
  approx(m1.debts[1].payment, 300, 1e-9, 'B gets min 100 + A freed min 100 + leftover 100 in month 1');
  approx(res.months, 3);
});

test('mid-month redistribution: extra that clears target N hits target N+1 same month', () => {
  const s = E.defaultState();
  s.debts = [
    { name: 'Small', balance: 200, apr: 0, minPayment: 50 },
    { name: 'Next', balance: 800, apr: 0, minPayment: 50 }
  ];
  s.monthlyDebtBudget = 1000;
  const res = E.runStrategy(s, E.customOrder);
  const m1 = res.schedule[0];
  approx(m1.debts[0].balance, 0, 1e-9, 'small cleared');
  approx(m1.debts[1].balance, 0, 1e-9, 'leftover 750 + min finishes Next in the same month');
  approx(res.months, 1);
  approx(m1.remainingBudget, 0, 1e-9, 'budget fully consumed');
});

test('budget caps extras only: budget below minimums still pays all minimums', () => {
  const s = E.defaultState();
  s.debts = [
    { name: 'A', balance: 1000, apr: 0, minPayment: 300 },
    { name: 'B', balance: 1000, apr: 0, minPayment: 300 }
  ];
  s.monthlyDebtBudget = 200; // far below the 600 of minimums
  const res = E.runStrategy(s, E.customOrder);
  const m1 = res.schedule[0];
  approx(m1.debts[0].payment, 300, 1e-9, 'minimum paid in full');
  approx(m1.debts[1].payment, 300, 1e-9, 'minimum paid in full');
  approx(m1.remainingBudget, 0, 1e-9, 'remainingBudget floors at 0');
  assert(res.payable === true);
  approx(res.months, 4); // 200/mo net drawdown per debt... 1000-300=700, then 700-300=400...
});

test('interest accrues before payments', () => {
  const s = E.defaultState();
  s.debts = [{ name: 'A', balance: 1000, apr: 0.12, minPayment: 0 }];
  s.monthlyDebtBudget = 100;
  const m1 = E.runStrategy(s, E.avalancheOrder).schedule[0];
  approx(m1.debts[0].interest, 10, 1e-9, '1% of 1000');
  approx(m1.debts[0].balance, 910, 1e-9, '1000 + 10 interest - 100 payment');
});

test('balances at or below the epsilon are settled without float residue loops', () => {
  const s = E.defaultState();
  s.debts = [{ name: 'Dusty', balance: 100, apr: 0.24, minPayment: 0 }];
  s.monthlyDebtBudget = 33.333333;
  const res = E.payoffProjection(s);
  assert(res.payable === true, 'must terminate');
  const last = res.schedule[res.schedule.length - 1];
  approx(last.totalBalance, 0, PAYOFF_TOL(), 'final snapshot settles to zero');
});
function PAYOFF_TOL() { return 0.02; }

// ---- custom order -----------------------------------------------------------

test('custom order is respected exactly', () => {
  const s = mixedFixture();
  s.debtStrategy = 'custom';
  // stored order: Car(7%), Loan(12%), Card(24%) — deliberately not avalanche
  s.debts = [s.debts[1], s.debts[2], s.debts[0]];
  const res = E.payoffProjection(s);
  const firstPayoff = res.schedule.findIndex(row => row.debts.some(d => d.balance <= E.PAYOFF_EPSILON));
  const cleared = res.schedule[firstPayoff].debts.find(d => d.balance <= E.PAYOFF_EPSILON);
  assert(cleared.name === 'Car', `custom order clears stored-first debt "Car", got "${cleared.name}"`);
});

test('reorder equivalence: custom order equal to avalanche order gives identical schedules', () => {
  const custom = mixedFixture();
  custom.debts.sort((a, b) => b.apr - a.apr); // same order avalanche would pick
  custom.debtStrategy = 'custom';
  const av = mixedFixture();
  av.debtStrategy = 'avalanche';
  const a = E.payoffProjection(custom);
  const b = E.payoffProjection(av);
  // snapshot rows follow stored debts[] order and float sums differ in the
  // last ulp; compare per-debt by name with a small tolerance
  assert(a.schedule.length === b.schedule.length);
  a.schedule.forEach((row, i) => {
    const other = b.schedule[i];
    approx(row.totalBalance, other.totalBalance, 1e-6, `month ${row.month} totalBalance`);
    approx(row.remainingBudget, other.remainingBudget, 1e-9, `month ${row.month} remainingBudget`);
    const byName = {};
    other.debts.forEach(d => { byName[d.name] = d; });
    row.debts.forEach(d => {
      const o = byName[d.name];
      assert(o, `month ${row.month}: missing debt ${d.name}`);
      approx(d.balance, o.balance, 1e-6, `month ${row.month} ${d.name} balance`);
      approx(d.payment, o.payment, 1e-9, `month ${row.month} ${d.name} payment`);
    });
  });
  approx(a.totalInterest, b.totalInterest, 1e-6);
});

// ---- unpayable & negative amortization --------------------------------------

test('unpayable debt: payable false, months null, schedule hits the cap', () => {
  const s = E.defaultState();
  s.debts = [{ name: 'Huge', balance: 1000000, apr: 0.24, minPayment: 0 }];
  s.monthlyDebtBudget = 0;
  const res = E.payoffProjection(s);
  assert(res.payable === false);
  assert(res.months === null);
  assert(res.debtFreeDate === null);
  assert(res.schedule.length === E.MAX_MONTHS);
});

test('negative amortization is flagged by validate', () => {
  const s = E.defaultState();
  s.debts = [{ name: 'Sinking', balance: 10000, apr: 0.24, minPayment: 100 }];
  s.monthlyDebtBudget = 5000; // budget is fine; the minimum itself is the problem
  const issues = E.validate(s);
  assert(issues.some(i => /grows every month/i.test(i)), 'negative-amortization warning');
});

test('validate warns when budget is below the sum of minimums', () => {
  const s = mixedFixture();
  s.monthlyDebtBudget = 100; // minimums total 600
  assert(E.validate(s).some(i => /below the sum of minimum/i.test(i)));
  s.monthlyDebtBudget = 600;
  assert(!E.validate(s).some(i => /below the sum of minimum/i.test(i)));
});

test('validate warns on an empty debt list', () => {
  assert(E.validate(E.defaultState()).some(i => /no debts yet/i.test(i)));
});

// ---- normalize --------------------------------------------------------------

test('normalize clamps out-of-range inputs and fills missing fields', () => {
  const s = E.normalizeState({
    debts: [{ name: '', balance: -50, apr: 7, minPayment: -10 }],
    monthlyDebtBudget: -99,
    debtStrategy: 'highest-first'
  });
  const d = s.debts[0];
  assert(d.name === 'Debt 1');
  assert(d.balance === 0);
  assert(d.apr === 1, 'apr clamped into [0,1]');
  assert(d.minPayment === 0);
  assert(s.monthlyDebtBudget === 0);
  assert(s.debtStrategy === 'avalanche', 'unknown strategy falls back');
});

test('normalize keeps valid values and known strategies', () => {
  const s = E.normalizeState({
    debts: [{ name: 'Chase Visa', balance: 12000, apr: 0.24, minPayment: 300 }],
    monthlyDebtBudget: 2500,
    debtStrategy: 'snowball'
  });
  assert(s.debts[0].name === 'Chase Visa');
  approx(s.debts[0].apr, 0.24);
  assert(s.debtStrategy === 'snowball');
  assert(s.you.currentAge === null, 'age optional');
});

test('normalize sanitizes malformed and null debt entries', () => {
  const s = E.normalizeState({
    debts: [null, { balance: 500 }, { name: 'Ok', balance: 100, apr: 0.1, minPayment: 25 }]
  });
  const [a, b, c] = s.debts;
  assert(a.name === 'Debt 1' && a.balance === 0, 'null entry becomes placeholder');
  assert(b.name === 'Debt 2' && b.apr === 0, 'partial entry filled');
  assert(c.name === 'Ok' && c.balance === 100, 'good entry preserved');
});

test('normalize accepts garbage input as defaults', () => {
  const s = E.normalizeState('nonsense');
  assert(Array.isArray(s.debts) && s.debts.length === 0);
  assert(s.debtStrategy === 'avalanche');
});

// ---- degenerate cases -------------------------------------------------------

test('zero budget with zero minimums makes no progress but terminates', () => {
  const s = E.defaultState();
  s.debts = [{ name: 'Stuck', balance: 5000, apr: 0, minPayment: 0 }];
  s.monthlyDebtBudget = 0;
  const res = E.payoffProjection(s);
  assert(res.payable === false);
  assert(res.schedule.length === E.MAX_MONTHS);
});

test('already-zero-balance debts are ignored', () => {
  const s = E.defaultState();
  s.debts = [
    { name: 'Gone', balance: 0, apr: 0.2, minPayment: 100 },
    { name: 'Real', balance: 100, apr: 0, minPayment: 0 }
  ];
  s.monthlyDebtBudget = 50;
  const res = E.payoffProjection(s);
  assert(res.payable === true);
  approx(res.months, 2);
  approx(res.totalInterest, 0, 1e-9);
});

test('single debt pays off and reports a debt-free date', () => {
  const s = E.defaultState();
  s.debts = [{ name: 'Solo', balance: 1200, apr: 0, minPayment: 100 }];
  s.monthlyDebtBudget = 100;
  const res = E.payoffProjection(s);
  approx(res.months, 12);
  assert(res.debtFreeDate instanceof Date);
});

test('fullProjection wires result, comparison, and issues together', () => {
  const p = E.fullProjection(E.sampleState());
  assert(p.result.payable === true);
  assert(p.comparison.savings.interest >= 0);
  assert(Array.isArray(p.issues));
});

// ---- report ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFailures:');
  failures.forEach(f => console.error(`- ${f}`));
  process.exit(1);
}
