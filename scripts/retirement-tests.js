#!/usr/bin/env node
/*
 * Automated tests for the retirement calculator engine.
 *
 * Zero-dependency, matching the repo's plain-node convention (see check-links.js).
 * Run with:  node scripts/retirement-tests.js
 * Exits non-zero if any assertion fails.
 */
const path = require('path');
const E = require(path.join(__dirname, '..', 'retirement-engine.js'));

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

// A minimal, hand-verifiable state: pure accumulation, no taxes/income/spending.
function accumOnly(overrides) {
  const s = E.defaultState();
  s.you = { currentAge: 30, retireAge: 33, endAge: 32 }; // exactly 3 accumulation years (ages 30,31,32)
  s.accounts = { taxable: 0, traditional: 1000, roth: 0, cash: 0, hsa: 0 };
  s.contributions = { taxable: 0, traditional: 0, roth: 0, hsa: 0, employerMatch: 0 };
  s.income.forEach(i => i.amount = 0);
  s.spending.baseline = 0;
  s.assumptions.returnAccum = 0.10;
  s.assumptions.returnRetire = 0.10;
  s.assumptions.inflation = 0;
  s.assumptions.contributionGrowth = 0;
  return Object.assign(s, overrides || {});
}

// ---- normalize / validate ----

test('normalizeState fills defaults and coerces bad numbers', () => {
  const s = E.normalizeState({ you: { currentAge: 'x', retireAge: 65, endAge: 90 }, accounts: { taxable: -5 } });
  assert(Number.isFinite(s.you.currentAge), 'currentAge finite');
  assert(s.you.retireAge === 65, 'retireAge kept');
  assert(s.accounts.taxable === 0, 'negative balance clamped to 0');
  assert(Array.isArray(s.strategy.withdrawalOrder), 'order present');
});

test('validate flags end age before retirement age', () => {
  const s = E.normalizeState(E.defaultState());
  s.you = { currentAge: 40, retireAge: 70, endAge: 65 };
  const issues = E.validate(s);
  assert(issues.some(m => /end-of-plan age must be after retirement/i.test(m)), 'expected end-age issue');
});

// ---- deterministic growth math ----

test('pure accumulation compounds correctly (1000 @ 10% x3 = 1331)', () => {
  const r = E.projectDeterministic(accumOnly());
  approx(r.endBalance, 1331, 1e-6, 'compound growth');
  assert(r.success, 'accumulation-only always succeeds');
  assert(r.depletionAge === null, 'no depletion');
});

test('contributions are added before growth each year', () => {
  const s = accumOnly();
  s.accounts.traditional = 0;
  s.contributions.traditional = 100; // +100 then grow 10% each of 3 years
  // yr1: (0+100)*1.1=110; yr2: (110+100)*1.1=231; yr3: (231+100)*1.1=364.1
  const r = E.projectDeterministic(s);
  approx(r.endBalance, 364.1, 1e-6, 'contrib-then-grow');
});

test('employer match lands in the traditional account', () => {
  const s = accumOnly();
  s.accounts.traditional = 0;
  s.contributions.traditional = 0;
  s.contributions.employerMatch = 100;
  const r = E.projectDeterministic(s);
  approx(r.endBalance, 364.1, 1e-6, 'match compounds like a contribution');
});

test('contribution growth raises contributions over time', () => {
  const s = accumOnly();
  s.accounts.traditional = 0;
  s.contributions.traditional = 100;
  s.assumptions.contributionGrowth = 0.10;
  // contrib grows 10%/yr: 100,110,121 ; each grown at 10%
  // yr1:(100)*1.1=110; yr2:(110+110)*1.1=242; yr3:(242+121)*1.1=399.3
  const r = E.projectDeterministic(s);
  approx(r.endBalance, 399.3, 1e-6, 'growing contributions');
});

// ---- withdrawals & taxes ----

test('Roth withdrawals are untaxed; traditional grossed up for tax', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 65 }; // single retirement year
  s.accounts = { taxable: 0, traditional: 0, roth: 100000, cash: 0, hsa: 0 };
  s.income.forEach(i => i.amount = 0);
  s.spending.baseline = 10000;
  s.spending.phased.enabled = false;
  s.assumptions.inflation = 0;
  s.assumptions.returnRetire = 0;
  s.assumptions.taxRate = 0.25;
  const r = E.projectDeterministic(s);
  // Roth: net need 10000 => gross 10000, no tax. Ends 90000.
  approx(r.rows[0].taxes, 0, 1e-6, 'roth untaxed');
  approx(r.endBalance, 90000, 1e-6, 'roth balance after withdrawal');

  s.accounts = { taxable: 0, traditional: 100000, roth: 0, cash: 0, hsa: 0 };
  const r2 = E.projectDeterministic(s);
  // traditional at 25%: gross = 10000/0.75 = 13333.33; tax = 3333.33; ends 86666.67
  approx(r2.rows[0].taxes, 3333.333333, 1e-4, 'traditional tax grossed up');
  approx(r2.endBalance, 86666.6667, 1e-3, 'traditional balance after gross withdrawal');
});

test('withdrawal order draws cash before taxable before traditional', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 65 };
  s.accounts = { taxable: 5000, traditional: 100000, roth: 0, cash: 3000, hsa: 0 };
  s.income.forEach(i => i.amount = 0);
  s.spending.baseline = 6000;
  s.spending.phased.enabled = false;
  s.assumptions.inflation = 0;
  s.assumptions.returnRetire = 0;
  s.assumptions.taxRate = 0.20;
  s.assumptions.taxableGainFraction = 0;
  const r = E.projectDeterministic(s);
  const row = r.rows[0];
  approx(row.cash, 0, 1e-6, 'cash drained first');
  approx(row.taxable, 2000, 1e-6, 'then taxable used (3000 cash + 3000 taxable = 6000)');
  approx(row.traditional, 100000, 1e-6, 'traditional untouched');
});

test('surplus guaranteed income is reinvested, not lost', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 65 };
  s.accounts = { taxable: 0, traditional: 0, roth: 0, cash: 1000, hsa: 0 };
  s.income = [{ type: 'other', label: 'Pension', amount: 40000, startAge: 65, cola: false }];
  s.spending.baseline = 30000;
  s.spending.phased.enabled = false;
  s.assumptions.inflation = 0;
  s.assumptions.returnRetire = 0;
  const r = E.projectDeterministic(s);
  // income 40k - spend 30k = +10k surplus into taxable; plus 1000 cash = 11000
  approx(r.endBalance, 11000, 1e-6, 'surplus reinvested');
  assert(r.success, 'income covers spending');
});

// ---- depletion / success ----

test('depletion is detected and reported by age', () => {
  const s = E.defaultState();
  s.you = { currentAge: 60, retireAge: 60, endAge: 70 };
  s.accounts = { taxable: 0, traditional: 0, roth: 20000, cash: 0, hsa: 0 };
  s.income.forEach(i => i.amount = 0);
  s.spending.baseline = 15000;
  s.spending.phased.enabled = false;
  s.assumptions.inflation = 0;
  s.assumptions.returnRetire = 0;
  const r = E.projectDeterministic(s);
  assert(!r.success, 'should fail');
  // yr1 spend 15k from 20k -> 5k; yr2 needs 15k, only 5k -> depletes at age 61
  assert(r.depletionAge === 61, 'depletion at 61, got ' + r.depletionAge);
});

test('guaranteed income alone covering spending counts as success (zero assets)', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 90 };
  s.accounts = { taxable: 0, traditional: 0, roth: 0, cash: 0, hsa: 0 };
  s.income = [{ type: 'other', label: 'Pension', amount: 50000, startAge: 65, cola: true }];
  s.spending.baseline = 40000;
  s.spending.phased.enabled = false;
  const r = E.projectDeterministic(s);
  assert(r.success, 'income >= spending every year is a success even with no assets');
});

// ---- Social Security claiming factor ----

test('Social Security claiming factors match SSA rules', () => {
  approx(E.ssFactor(67, 67), 1.0, 1e-9, 'FRA = 100%');
  approx(E.ssFactor(62, 67), 0.70, 1e-9, 'claim at 62 = 70%');
  approx(E.ssFactor(70, 67), 1.24, 1e-9, 'claim at 70 = 124%');
  approx(E.ssFactor(66, 67), 1 - 12 * (5 / 9) / 100, 1e-9, '1 yr early');
});

test('delaying Social Security raises the modeled benefit', () => {
  const base = E.defaultState();
  base.you = { currentAge: 62, retireAge: 62, endAge: 63 };
  base.accounts = { taxable: 0, traditional: 0, roth: 0, cash: 1000000, hsa: 0 };
  base.income = [{ type: 'socialSecurity', label: 'SS', amount: 30000, startAge: 67, cola: false }];
  base.spending.baseline = 0;
  base.spending.phased.enabled = false;
  base.assumptions.inflation = 0;
  base.assumptions.returnRetire = 0;

  const at62 = JSON.parse(JSON.stringify(base)); at62.strategy.ssClaimAge = 62;
  const at70 = JSON.parse(JSON.stringify(base)); at70.strategy.ssClaimAge = 70;
  const r62 = E.projectDeterministic(at62);
  const r70 = E.projectDeterministic(at70);
  // at 62 SS starts immediately (2 yrs of 70% benefit reinvested); at 70 it never starts in window
  assert(r62.endBalance > r70.endBalance, 'claiming early in this window adds income');
  approx(r62.rows[0].income, 30000 * 0.70, 1e-6, 'age-62 benefit is 70%');
  approx(r70.rows[0].income, 0, 1e-6, 'age-70 claim: no SS before 70');
});

// ---- RMDs ----

test('RMD forces a taxable traditional withdrawal even when not needed', () => {
  const s = E.defaultState();
  s.you = { currentAge: 73, retireAge: 73, endAge: 73 };
  s.accounts = { taxable: 0, traditional: 265000, roth: 0, cash: 1000000, hsa: 0 };
  s.income.forEach(i => i.amount = 0);
  s.spending.baseline = 10000; // easily covered by cash, so traditional wouldn't be touched
  s.spending.phased.enabled = false;
  s.assumptions.inflation = 0;
  s.assumptions.returnRetire = 0;
  s.assumptions.taxRate = 0.20;
  const r = E.projectDeterministic(s);
  // RMD at 73 = 265000 / 26.5 = 10000, taxed 20% => 2000 tax, 8000 net reinvested to taxable
  approx(r.rows[0].traditional, 255000, 1e-4, 'RMD removed 10000 from traditional');
  assert(r.rows[0].taxes >= 2000 - 1e-6, 'RMD generated tax');
});

test('no RMD before age 73', () => {
  approx(E.rmdRequired(72, 1000000), 0, 1e-9, 'no RMD at 72');
  assert(E.rmdRequired(73, 265000) > 0, 'RMD at 73');
});

// ---- phased spending, healthcare, LTC ----

test('phased spending uses the right band per age', () => {
  const s = E.defaultState();
  s.assumptions.inflation = 0;
  s.spending.phased = { enabled: true, goGo: 90000, slowGo: 60000, noGo: 40000, slowGoAge: 75, noGoAge: 85 };
  approx(E.spendingForYear(s, 70, 5), 90000, 1e-6, 'go-go');
  approx(E.spendingForYear(s, 80, 15), 60000, 1e-6, 'slow-go');
  approx(E.spendingForYear(s, 88, 23), 40000, 1e-6, 'no-go');
});

test('healthcare adds a pre-Medicare premium that ends at 65', () => {
  const s = E.defaultState();
  s.assumptions.inflation = 0;
  s.spending.baseline = 0;
  s.spending.phased.enabled = false;
  s.spending.healthcare = { enabled: true, preMedicarePremium: 12000, medicareAnnual: 7000, irmaaTier: 0, medicalInflation: 0 };
  approx(E.spendingForYear(s, 63, 0), 12000, 1e-6, 'pre-65 premium');
  approx(E.spendingForYear(s, 66, 0), 7000, 1e-6, 'post-65 Medicare');
});

test('IRMAA surcharge is added on top of Medicare for higher tiers', () => {
  const s = E.defaultState();
  s.assumptions.inflation = 0;
  s.spending.baseline = 0;
  s.spending.phased.enabled = false;
  s.spending.healthcare = { enabled: true, preMedicarePremium: 0, medicareAnnual: 7000, irmaaTier: 2, medicalInflation: 0 };
  approx(E.spendingForYear(s, 70, 0), 7000 + E.irmaaSurcharge(2), 1e-6, 'medicare + irmaa');
});

test('LTC applies only within its window', () => {
  const s = E.defaultState();
  s.assumptions.inflation = 0;
  s.spending.baseline = 0;
  s.spending.phased.enabled = false;
  s.spending.ltc = { enabled: true, annualCost: 100000, years: 3, startAge: 88 };
  approx(E.spendingForYear(s, 87, 0), 0, 1e-6, 'before window');
  approx(E.spendingForYear(s, 88, 0), 100000, 1e-6, 'in window');
  approx(E.spendingForYear(s, 90, 0), 100000, 1e-6, 'last window year');
  approx(E.spendingForYear(s, 91, 0), 0, 1e-6, 'after window');
});

// ---- sequence-of-returns risk ----

test('return ordering does not change accumulation-only end balance', () => {
  const s = accumOnly();
  s.you = { currentAge: 30, retireAge: 33, endAge: 32 };
  s.accounts.traditional = 1000;
  const seqA = [0.30, -0.10, 0.05];
  const seqB = [0.05, -0.10, 0.30];
  const a = E.projectWithReturns(s, seqA).endBalance;
  const b = E.projectWithReturns(s, seqB).endBalance;
  approx(a, b, 1e-6, 'multiplication is commutative with no cashflows');
});

test('early losses hurt more than late losses once withdrawing', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 68 };
  s.accounts = { taxable: 0, traditional: 0, roth: 100000, cash: 0, hsa: 0 };
  s.income.forEach(i => i.amount = 0);
  s.spending.baseline = 20000;
  s.spending.phased.enabled = false;
  s.assumptions.inflation = 0;
  s.assumptions.taxRate = 0;
  const badEarly = E.projectWithReturns(s, [-0.30, 0.10, 0.10, 0.10]).endBalance;
  const badLate = E.projectWithReturns(s, [0.10, 0.10, 0.10, -0.30]).endBalance;
  assert(badLate > badEarly, 'a late crash leaves more than an early crash when withdrawing');
});

test('guardrails cuts spending the year after a market loss (prevReturn wiring)', () => {
  const base = E.defaultState();
  base.you = { currentAge: 65, retireAge: 65, endAge: 85 };
  base.accounts = { taxable: 0, traditional: 0, roth: 800000, cash: 0, hsa: 0 };
  base.income.forEach(i => i.amount = 0);
  base.spending.baseline = 45000;
  base.spending.phased.enabled = false;
  base.assumptions.inflation = 0.02;
  base.assumptions.taxRate = 0;
  base.strategy.withdrawalMethod = 'guardrails';
  const years = base.you.endAge - base.you.currentAge + 1;
  const good = new Array(years).fill(0.05);
  const loss = good.slice(); loss[1] = -0.35; // big drop in the 2nd retirement year (t=1)
  const sGood = E.projectWithReturns(base, good);
  const sLoss = E.projectWithReturns(base, loss);
  // year t=2 is the first year that can see the t=1 loss as "last year"; guardrails should hold back.
  assert(sLoss.rows[2].spending < sGood.rows[2].spending - 1,
    `guardrails should spend less after a loss year (loss ${sLoss.rows[2].spending.toFixed(0)} vs good ${sGood.rows[2].spending.toFixed(0)})`);
});

// ---- Monte Carlo ----

test('Monte Carlo is deterministic for a fixed seed', () => {
  const s = E.sampleState();
  const a = E.runMonteCarlo(s, { iterations: 300, seed: 42 });
  const b = E.runMonteCarlo(s, { iterations: 300, seed: 42 });
  approx(a.successRate, b.successRate, 1e-12, 'same seed -> same success rate');
  approx(a.terminal.p50, b.terminal.p50, 1e-6, 'same seed -> same median');
});

test('Monte Carlo success is 100% when income always covers spending', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 90 };
  s.accounts = { taxable: 0, traditional: 0, roth: 0, cash: 0, hsa: 0 };
  s.income = [{ type: 'other', label: 'Pension', amount: 60000, startAge: 65, cola: true }];
  s.spending.baseline = 40000;
  s.spending.phased.enabled = false;
  const mc = E.runMonteCarlo(s, { iterations: 200, seed: 7 });
  approx(mc.successRate, 1.0, 1e-9, 'guaranteed income => always succeeds');
});

test('Monte Carlo success is ~0% when tiny assets face large spending', () => {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 90 };
  s.accounts = { taxable: 0, traditional: 0, roth: 1000, cash: 0, hsa: 0 };
  s.income.forEach(i => i.amount = 0);
  s.spending.baseline = 50000;
  s.spending.phased.enabled = false;
  const mc = E.runMonteCarlo(s, { iterations: 200, seed: 7 });
  approx(mc.successRate, 0.0, 1e-9, 'no way to fund => always fails');
});

test('Monte Carlo terminal percentiles are ordered p10 <= p50 <= p90', () => {
  const mc = E.runMonteCarlo(E.sampleState(), { iterations: 400, seed: 123 });
  assert(mc.terminal.p10 <= mc.terminal.p50 + 1e-6, 'p10<=p50');
  assert(mc.terminal.p50 <= mc.terminal.p90 + 1e-6, 'p50<=p90');
  assert(mc.bands.length === (mc.state.you.endAge - mc.state.you.currentAge + 1), 'one band per year');
  for (const band of mc.bands) {
    assert(band.p10 <= band.p50 + 1e-6 && band.p50 <= band.p90 + 1e-6, 'band ordered at age ' + band.age);
  }
});

test('verdict thresholds map to labels', () => {
  assert(E.verdict(0.95).tone === 'good', '95% good');
  assert(E.verdict(0.6).tone === 'warn', '60% warn');
  assert(E.verdict(0.2).tone === 'bad', '20% bad');
});

// ---- share-link codec round-trip ----

test('compactState -> expandState round-trips a full state', () => {
  const s = E.normalizeState(E.sampleState());
  const restored = E.expandState(E.compactState(s));
  approx(restored.you.currentAge, s.you.currentAge, 0, 'age');
  approx(restored.accounts.traditional, s.accounts.traditional, 1e-9, 'balance');
  approx(restored.spending.baseline, s.spending.baseline, 1e-9, 'baseline');
  assert(restored.spending.phased.enabled === s.spending.phased.enabled, 'phased flag');
  assert(restored.strategy.withdrawalMethod === s.strategy.withdrawalMethod, 'method');
  assert(restored.strategy.ssClaimAge === s.strategy.ssClaimAge, 'ss claim age');
  assert(restored.income.length === s.income.length, 'income length');
  // A full projection on the restored state matches the original.
  approx(E.projectDeterministic(restored).endBalance, E.projectDeterministic(s).endBalance, 1e-6, 'projection matches after round-trip');
});

test('withdrawal-order round-trips through the codec', () => {
  const s = E.normalizeState(E.defaultState());
  s.strategy.withdrawalOrder = ['roth', 'cash', 'taxable', 'traditional', 'hsa'];
  const restored = E.expandState(E.compactState(s));
  assert(restored.strategy.withdrawalOrder.join(',') === 'roth,cash,taxable,traditional,hsa', 'order preserved');
});

// ---- itemized post-retirement expenses ----

function itemsState(overrides) {
  const s = E.defaultState();
  s.you = { currentAge: 65, retireAge: 65, endAge: 90 };
  s.spending.mode = 'items';
  s.spending.items = [
    { label: 'Mortgage', category: 'housing', amount: 2000, frequency: 'monthly', inflation: 'fixed', startAge: null, endAge: null },
    { label: 'Property tax', category: 'housing', amount: 6000, frequency: 'annual', inflation: 'general', startAge: null, endAge: null }
  ];
  return Object.assign(s, overrides);
}

test('itemAnnual converts monthly lines to annual equivalents', () => {
  approx(E.itemAnnual({ amount: 2000, frequency: 'monthly' }), 24000, 1e-9, 'monthly x12');
  approx(E.itemAnnual({ amount: 6000, frequency: 'annual' }), 6000, 1e-9, 'annual passthrough');
});

test('items mode sums line items in place of the flat baseline', () => {
  const s = itemsState();
  // t=0: mortgage 24k (fixed) + tax 6k = 30k
  approx(E.spendingForYear(s, 65, 0), 30000, 1e-6, 't=0 sum');
  // t=10: mortgage still 24k nominal; tax inflated at 3% for 10y
  approx(E.spendingForYear(s, 75, 10), 24000 + 6000 * Math.pow(1.03, 10), 1e-4, 't=10 mixed inflation');
});

test('fixed lines hold nominal value so their real cost shrinks', () => {
  const s = itemsState();
  s.spending.items = [{ label: 'Loan', amount: 10000, frequency: 'annual', inflation: 'fixed', startAge: null, endAge: null }];
  approx(E.spendingForYear(s, 70, 20), 10000, 1e-9, 'nominal constant');
  approx(E.spendingForYear(s, 70, 20) / Math.pow(1.03, 20), 10000 / Math.pow(1.03, 20), 1e-6, 'real shrinks');
});

test('medical lines grow at medical inflation, not general', () => {
  const s = itemsState();
  s.spending.healthcare.medicalInflation = 0.05;
  s.spending.items = [{ label: 'Premium', amount: 5000, frequency: 'annual', inflation: 'medical', startAge: null, endAge: null }];
  approx(E.spendingForYear(s, 70, 10), 5000 * Math.pow(1.05, 10), 1e-4, 'medical rate');
});

test('age windows include and exclude line items correctly', () => {
  const s = itemsState();
  s.spending.items = [
    { label: 'Early', amount: 1000, frequency: 'annual', inflation: 'general', startAge: null, endAge: 74 },
    { label: 'Late', amount: 2000, frequency: 'annual', inflation: 'general', startAge: 80, endAge: null }
  ];
  approx(E.spendingForYear(s, 65, 0), 1000, 1e-9, 'early only');
  approx(E.spendingForYear(s, 77, 12), 0, 1e-9, 'gap year');
  approx(E.spendingForYear(s, 85, 20), 2000 * Math.pow(1.03, 20), 1e-4, 'late only');
});

test('flat mode and an equivalent items list produce identical projections', () => {
  const flat = E.defaultState();
  flat.you = { currentAge: 60, retireAge: 65, endAge: 90 };
  flat.spending.baseline = 60000;
  const itemized = E.normalizeState(JSON.parse(JSON.stringify(flat)));
  itemized.spending.mode = 'items';
  itemized.spending.items = [
    { label: 'A', amount: 40000, frequency: 'annual', inflation: 'general', startAge: null, endAge: null },
    { label: 'B', amount: 1666.6666666666667, frequency: 'monthly', inflation: 'general', startAge: null, endAge: null }
  ];
  const a = E.projectDeterministic(flat);
  const b = E.projectDeterministic(itemized);
  approx(a.endBalance, b.endBalance, 1.0, 'end balance matches (within rounding of the monthly line)');
  assert(a.depletionAge === b.depletionAge, 'depletion age matches');
});

test('healthcare, LTC, and one-offs stay additive on top of items mode', () => {
  const s = itemsState();
  s.spending.healthcare.enabled = true;
  s.spending.healthcare.medicareAnnual = 5000;
  s.spending.ltc = { enabled: true, annualCost: 80000, years: 2, startAge: 80 };
  s.spending.oneOffs = [{ label: 'Roof', amount: 20000, age: 70 }];
  // base 30k + medicare 5k at 65 (t=0)
  approx(E.spendingForYear(s, 65, 0), 35000, 1e-6, 'healthcare added');
  // LTC window is ages 80-81; at 81 (t=16) both healthcare and LTC apply
  const t81 = 16, minfl = s.spending.healthcare.medicalInflation;
  const expected81 = 24000
    + 6000 * Math.pow(1.03, t81)
    + 5000 * Math.pow(1 + minfl, t81)
    + 80000 * Math.pow(1 + minfl, t81);
  approx(E.spendingForYear(s, 81, t81), expected81, 1e-3, 'LTC + healthcare added');
  // outside the LTC window the cost drops back
  assert(E.spendingForYear(s, 82, 17) < E.spendingForYear(s, 81, 16), 'LTC ends');
  // one-off at 70 (t=5); healthcare is still on (Medicare 65+)
  approx(E.spendingForYear(s, 70, 5),
    (24000 + 6000 * Math.pow(1.03, 5)) + 5000 * Math.pow(1.05, 5) + 20000 * Math.pow(1.03, 5), 50, 'one-off added');
});

test('withdrawal methods reshape only the items component in items mode', () => {
  const s = itemsState();
  s.strategy.withdrawalMethod = 'fourPercent';
  approx(E.baselineComponent(s, 70, 5), E.itemsForYear(s, 70, 5), 1e-6, 'baseline component equals items total');
});

test('normalize sanitizes malformed expense items', () => {
  const s = E.normalizeState({ spending: { mode: 'items', items: [
    { label: '', amount: -500, frequency: 'weekly', inflation: 'crypto', startAge: 'x', endAge: 999 },
    null,
    { label: 'Ok', amount: 100, frequency: 'monthly', inflation: 'fixed', startAge: 70, endAge: '' }
  ] } });
  const [a, b, c] = s.spending.items;
  assert(a.label === 'Expense 1' && a.amount === 0 && a.frequency === 'annual' && a.inflation === 'general', 'bad fields fall back');
  assert(a.startAge === null && a.endAge === 120, 'ages sanitized');
  assert(b.label === 'Expense 2' && b.amount === 0, 'null item becomes empty line');
  assert(c.frequency === 'monthly' && c.inflation === 'fixed' && c.startAge === 70 && c.endAge === null, 'good item preserved');
});

test('validate warns when items mode has no line items', () => {
  const s = itemsState();
  s.spending.items = [];
  assert(E.validate(s).some(i => /expense list is empty/i.test(i)), 'empty-list warning');
  s.spending.items = [{ label: 'X', amount: 1, frequency: 'annual', inflation: 'general', startAge: null, endAge: null }];
  assert(!E.validate(s).some(i => /expense list is empty/i.test(i)), 'no warning with items');
});

// ---- report ----

if (failures.length) {
  console.error(`\nRetirement engine tests: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`Retirement engine tests: ${passed} passed, 0 failed`);
