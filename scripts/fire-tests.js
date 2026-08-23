#!/usr/bin/env node
/*
 * Automated tests for the FIRE calculator engine.
 *
 * Zero-dependency, matching the repo's plain-node convention (see
 * scripts/retirement-tests.js). Run with:  node scripts/fire-tests.js
 * Exits non-zero if any assertion fails.
 */
const path = require('path');
const E = require(path.join(__dirname, '..', 'fire-engine.js'));

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

// ---- FIRE number -----------------------------------------------------------

test('4% rule identity: no tax, 4% WR, $40k spend -> $1M', () => {
  const r = E.fireNumber({ money: { annualSpending: 40000 }, assumptions: { taxRate: 0, withdrawalRate: 0.04 } });
  approx(r.grossWithdrawal, 40000);
  approx(r.fireNumber, 1000000);
  approx(r.spendingMultiple, 25);
});

test('tax gross-up: 20% tax raises the required number to $1.25M', () => {
  const r = E.fireNumber({ money: { annualSpending: 40000 }, assumptions: { taxRate: 0.20, withdrawalRate: 0.04 } });
  approx(r.grossWithdrawal, 50000);
  approx(r.fireNumber, 1250000);
});

test('lower withdrawal rate scales the number up (3% -> ~33x)', () => {
  const r = E.fireNumber({ money: { annualSpending: 40000 }, assumptions: { taxRate: 0, withdrawalRate: 0.03 } });
  approx(r.fireNumber, 40000 / 0.03);
});

// ---- real return -----------------------------------------------------------

test('real return converts nominal minus inflation', () => {
  approx(E.realReturn({ assumptions: { nominalReturn: 0.08, inflation: 0.03 } }), 1.08 / 1.03 - 1);
});

test('zero nominal return with positive inflation is negative real', () => {
  assert(E.realReturn({ assumptions: { nominalReturn: 0, inflation: 0.03 } }) < 0);
});

// ---- Coast FIRE ------------------------------------------------------------

test('coast number matches the published $1M / 5% real / 35y example', () => {
  const s = E.defaultState();
  s.you = { currentAge: 30, targetAge: 65 };
  s.money = { annualSpending: 40000, currentBalance: 0, annualSavings: 0 };
  s.assumptions = { withdrawalRate: 0.04, taxRate: 0, nominalReturn: 0.05, inflation: 0 };
  const c = E.coastNumber(s);
  approx(c.fireNumber, 1000000);
  approx(c.years, 35);
  approx(c.coastNumber, 181290, 10); // 1e6 / 1.05^35 ≈ 181,290
});

test('projection of a current balance: $200k at 5% real for 30 years', () => {
  const s = E.defaultState();
  s.you = { currentAge: 35, targetAge: 65 };
  s.money = { annualSpending: 40000, currentBalance: 200000, annualSavings: 0 };
  s.assumptions = { withdrawalRate: 0.04, taxRate: 0, nominalReturn: 0.05, inflation: 0 };
  const c = E.coastNumber(s);
  approx(c.projectedBalance, 200000 * Math.pow(1.05, 30), 1);
  approx(c.projectedBalance, 864388, 5);
});

test('coast progress and on-track flag', () => {
  const s = E.defaultState();
  s.money = { annualSpending: 40000, currentBalance: 250000, annualSavings: 0 };
  s.assumptions = { withdrawalRate: 0.04, taxRate: 0, nominalReturn: 0.05, inflation: 0 };
  const c = E.coastNumber(s);
  approx(c.coastProgress, 250000 / c.coastNumber);
  assert(c.onTrack === true);

  s.money.currentBalance = 100000;
  assert(E.coastNumber(s).onTrack === false);
});

test('target age at or before current age collapses coast to the FIRE number', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, targetAge: 60 };
  const c = E.coastNumber(s);
  approx(c.years, 0);
  approx(c.coastNumber, c.fireNumber);
  approx(c.projectedBalance, s.money.currentBalance);
});

// ---- Years to FI -----------------------------------------------------------

test('already past the FIRE number -> zero years', () => {
  const s = E.defaultState();
  s.money = { annualSpending: 40000, currentBalance: 2000000, annualSavings: 24000 };
  const t = E.yearsToFi(s);
  assert(t.years === 0);
  assert(t.reachable === true);
  assert(t.schedule.length === 0);
});

test('closed form cross-check: iterated years match the annuity formula', () => {
  // balance_n = P(1+r)^n + c((1+r)^n - 1)/r  =>  n = ln((N*r+c)/(P*r+c)) / ln(1+r)
  const P = 200000, c0 = 24000, N = 1500000, r = 0.05;
  const closed = Math.log((N * r + c0) / (P * r + c0)) / Math.log(1 + r);
  const s = E.defaultState();
  s.you = { currentAge: 35, targetAge: 75 };
  s.money = { annualSpending: 60000, currentBalance: P, annualSavings: c0 };
  s.assumptions = { withdrawalRate: 0.04, taxRate: 0, nominalReturn: 0.05, inflation: 0 };
  const t = E.yearsToFi(s);
  assert(t.reachable === true);
  // iteration reports the first whole year-end at/above target
  assert(Math.ceil(closed - 1e-9) === t.years);
  approx(t.years, closed, 1);
});

test('schedule rows accumulate correctly year over year', () => {
  const s = E.defaultState();
  s.money = { annualSpending: 40000, currentBalance: 100000, annualSavings: 10000 };
  s.assumptions = { withdrawalRate: 0.04, taxRate: 0, nominalReturn: 0.05, inflation: 0 };
  const t = E.yearsToFi(s);
  assert(t.schedule.length === t.years);
  const first = t.schedule[0];
  approx(first.startBalance, 100000);
  approx(first.growth, 5000);
  approx(first.contribution, 10000);
  approx(first.endBalance, 115000);
  for (let i = 1; i < t.schedule.length; i++) {
    approx(t.schedule[i].startBalance, t.schedule[i - 1].endBalance, 1e-6);
  }
});

test('unreachable path is flagged after the cap', () => {
  const s = E.defaultState();
  s.money = { annualSpending: 1000000, currentBalance: 1000, annualSavings: 0 };
  s.assumptions = { withdrawalRate: 0.04, taxRate: 0, nominalReturn: 0.01, inflation: 0 };
  const t = E.yearsToFi(s);
  assert(t.reachable === false);
  assert(t.years === null);
  assert(t.schedule.length === E.MAX_YEARS);
});

// ---- normalize & validate --------------------------------------------------

test('normalize clamps out-of-range inputs and fills missing fields', () => {
  const s = E.normalizeState({
    you: { currentAge: -5, targetAge: 999 },
    money: { annualSpending: -100, currentBalance: 'oops' },
    assumptions: { taxRate: 2, withdrawalRate: 0, nominalReturn: 9 }
  });
  assert(s.you.currentAge === 0);
  assert(s.you.targetAge === 120);
  assert(s.money.annualSpending === 0);
  assert(s.money.currentBalance === 200000); // fallback default
  assert(s.assumptions.taxRate === 0.9);
  assert(s.assumptions.withdrawalRate === 0.005);
  assert(s.assumptions.nominalReturn === 0.5);
  assert(s.money.annualSavings === 24000); // filled from defaults
});

test('validate flags zero savings and non-positive real return', () => {
  const s = E.defaultState();
  s.money.annualSavings = 0;
  s.assumptions.nominalReturn = 0.01;
  s.assumptions.inflation = 0.03;
  const issues = E.validate(s);
  assert(issues.some(i => /no savings/i.test(i)));
  assert(issues.some(i => /real return/i.test(i)));
});

test('fullProjection wires all three results together', () => {
  const p = E.fullProjection(E.sampleState());
  approx(p.fire.fireNumber, p.coast.fireNumber);
  approx(p.realReturn, p.coast.realReturn);
  assert(Array.isArray(p.issues));
});

// ---- report ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFailures:');
  failures.forEach(f => console.error(`- ${f}`));
  process.exit(1);
}
