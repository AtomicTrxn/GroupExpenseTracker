#!/usr/bin/env node
/*
 * Automated tests for plan-state.js: unified schema, compression format
 * markers, version/migration policy, legacy migration, and the cross-page
 * prefill mappings.
 *
 * Zero-dependency, matching the repo's plain-node convention. Requires
 * Node >= 18 (global CompressionStream exercises the 'C' path). Browser
 * globals are stubbed with plain objects BEFORE plan-state.js is required
 * (the module touches them only inside functions, never at load time).
 * Run with:  node scripts/pipeline-tests.js
 * Exits non-zero if any assertion fails.
 */

// ---- browser global stubs ---------------------------------------------------

const store = new Map();
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
let lastReplaced = null;
global.location = { hash: '', pathname: '/index.html', search: '', href: 'https://example.com/index.html' };
global.history = {
  replaceState: (a, b, url) => { lastReplaced = url; }
};

const path = require('path');
const ROOT = path.join(__dirname, '..');
const FireEngine = require(path.join(ROOT, 'fire-engine.js'));
const RetirementEngine = require(path.join(ROOT, 'retirement-engine.js'));
const DebtEngine = require(path.join(ROOT, 'debt-engine.js'));
const P = require(path.join(ROOT, 'plan-state.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  const p = fn && fn.constructor.name === 'AsyncFunction'
    ? fn().then(() => { passed++; }).catch(e => failures.push(`${name}: ${e.message}`))
    : Promise.resolve();
  if (!fn || fn.constructor.name !== 'AsyncFunction') {
    try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
    return Promise.resolve();
  }
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function approx(actual, expected, tol, msg) {
  tol = tol == null ? 1e-6 : tol;
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg || 'approx'}: expected ${expected}, got ${actual} (tol ${tol})`);
  }
}

async function main() {

  // ---- compression & round-trip ---------------------------------------------

  await test('unified round-trip preserves all slices', async () => {
    const full = P.defaultFullState();
    full.meta.origin = 'debt-calculator';
    full.you.currentAge = 41;
    full.debts = [{ name: 'Chase Visa', balance: 12000, apr: 0.24, minPayment: 300 }];
    full.monthlyDebtBudget = 2500;
    full.debtStrategy = 'snowball';
    full.fire.you.currentAge = 41;
    full.retirement.accounts.taxable = 77777;

    const payload = await P.compressState(full);
    const parsed = await P.decompressState(payload);
    const norm = P.normalizeFullState(parsed);
    assert(JSON.stringify(norm.fire) === JSON.stringify(P.normalizeFullState(full).fire), 'fire slice intact');
    assert(JSON.stringify(norm.retirement) === JSON.stringify(P.normalizeFullState(full).retirement), 'retirement slice intact');
    assert(norm.you.currentAge === 41, 'age anchor intact');
    assert(norm.debts[0].name === 'Chase Visa' && norm.debts[0].apr === 0.24, 'debts intact');
    assert(norm.debtStrategy === 'snowball' && norm.monthlyDebtBudget === 2500);
  });

  await test('round-trip survives unicode and emoji debt names', async () => {
    const full = P.defaultFullState();
    full.debts = [
      { name: 'Crédit Lyonnais — prêt', balance: 5000, apr: 0.1, minPayment: 100 },
      { name: '💳 Card 💸', balance: 500, apr: 0.2, minPayment: 25 }
    ];
    const parsed = await P.decompressState(await P.compressState(full));
    const names = P.normalizeFullState(parsed).debts.map(d => d.name);
    assert(names[0] === 'Crédit Lyonnais — prêt');
    assert(names[1] === '💳 Card 💸');
  });

  await test('round-trip handles empty debts and itemized spending arrays', async () => {
    const full = P.defaultFullState();
    full.fire.money.mode = 'items';
    full.fire.money.items = [
      { label: 'Mortgage', amount: 2000, frequency: 'monthly' },
      { label: 'Food', amount: 800, frequency: 'monthly' }
    ];
    const parsed = await P.decompressState(await P.compressState(full));
    const norm = P.normalizeFullState(parsed);
    assert(Array.isArray(norm.debts) && norm.debts.length === 0);
    assert(norm.fire.money.mode === 'items' && norm.fire.money.items.length === 2);
    approx(FireEngine.annualSpendingFor(norm.fire), 24000 + 9600, 1e-9);
  });

  await test('format markers: C decodes, R decodes regardless, unknown throws', async () => {
    const obj = { hello: 'world', n: 42 };
    const cPayload = await P.compressState(obj);
    assert(typeof CompressionStream === 'function' ? cPayload[0] === 'C' : true,
      'C marker when CompressionStream exists');
    assert((await P.decompressState(cPayload)).n === 42);

    const raw = 'R' + P.bytesToBase64url(new TextEncoder().encode(JSON.stringify(obj)));
    assert((await P.decompressState(raw)).hello === 'world');

    let threw = false;
    try { await P.decompressState('X' + raw.slice(1)); } catch (e) { threw = true; }
    assert(threw, 'unknown marker rejected');
  });

  // ---- version handling -------------------------------------------------------

  await test('older states (v: 0) migrate forward instead of being rejected', async () => {
    const old = P.defaultFullState();
    delete old.v;
    old.v = 0;
    old.you.currentAge = 52;
    const payload = await P.compressState(old);
    location.hash = '#state=' + encodeURIComponent(payload);
    const errors = [];
    const loaded = await P.readSharedState(msg => errors.push(msg));
    assert(loaded, 'old state loads');
    assert(loaded.v === P.STATE_VERSION, 'migrated to current version');
    assert(loaded.you.currentAge === 52);
    assert(errors.length === 0);
    location.hash = '';
  });

  await test('newer states are rejected through the error callback, not silently', async () => {
    const future = P.defaultFullState();
    future.v = P.STATE_VERSION + 5;
    const payload = await P.compressState(future);
    location.hash = '#state=' + encodeURIComponent(payload);
    const errors = [];
    const loaded = await P.readSharedState(msg => errors.push(msg));
    assert(loaded === null, 'no state returned');
    assert(errors.length === 1 && /newer plan format/.test(errors[0]), 'explicit error surfaced');
    location.hash = '';
  });

  await test('corrupted link payloads surface an explicit error', async () => {
    location.hash = '#state=Cnot-real-base64!!!';
    const errors = [];
    const loaded = await P.readSharedState(msg => errors.push(msg));
    assert(loaded === null);
    assert(errors.length === 1 && /couldn't be read/.test(errors[0]));
    location.hash = '';
  });

  // ---- load / save ------------------------------------------------------------

  await test('saveState writes the working copy; load returns it when no hash', async () => {
    const full = P.defaultFullState();
    full.you.currentAge = 44;
    P.saveState(full);
    assert(store.has(P.STORAGE_KEY), 'localStorage written');
    const loaded = await P.load();
    assert(loaded.you.currentAge === 44);
  });

  // ---- legacy migration -------------------------------------------------------

  await test('legacy migration maps the real per-page keys into the unified schema', () => {
    store.clear();
    const fireLegacy = FireEngine.sampleState(); // { you, money, assumptions } shape
    fireLegacy.money.currentBalance = 123456;
    const retireLegacy = RetirementEngine.defaultState(); // accounts-as-object shape
    retireLegacy.accounts.traditional = 654321;
    retireLegacy.you.currentAge = 48;
    store.set('fire-calculator-state-v1', JSON.stringify(fireLegacy));
    store.set('retirementCalculator.v1', JSON.stringify(retireLegacy));

    const state = P.migrateLegacyState();
    assert(state, 'migration produced a state');
    approx(state.fire.money.currentBalance, 123456, 1e-9, 'fire slice mapped verbatim');
    approx(state.retirement.accounts.traditional, 654321, 1e-9, 'retirement slice mapped verbatim');
    assert(state.you.currentAge === 48, 'anchor follows the last legacy source');
    assert(store.has('fire-calculator-state-v1') && store.has('retirementCalculator.v1'),
      'legacy keys preserved (non-destructive)');
    assert(store.has(P.STORAGE_KEY), 'unified key written');
  });

  await test('legacy migration is idempotent and skips when no legacy keys exist', () => {
    const again = P.migrateLegacyState();
    assert(again, 're-runs while legacy keys remain');
    approx(again.retirement.accounts.traditional, 654321, 1e-9, 'same result');

    store.clear();
    assert(P.migrateLegacyState() === null, 'no-op without legacy keys');
  });

  // ---- prefill mappings -------------------------------------------------------

  await test('prefill debt→FIRE suggests budget×12 and an integer debt-free age', () => {
    const full = P.buildFullState({
      origin: 'debt-calculator',
      you: { currentAge: 35 },
      debts: [
        { name: 'Card', balance: 10000, apr: 0.24, minPayment: 250 },
        { name: 'Loan', balance: 5000, apr: 0.12, minPayment: 150 }
      ],
      debtStrategy: 'avalanche',
      monthlyDebtBudget: 2000
    });
    const pre = P.prefillFireFromDebt(full);
    approx(pre.fire.money.annualSavings, 24000, 1e-9, 'budget × 12');
    assert(Number.isInteger(pre.debtFreeAge), 'integer debt-free age');
    assert(pre.debtFreeAge > 35, 'after current age');
    // asserted through the receiving engine's normalizeState output
    const renorm = FireEngine.normalizeState(pre.fire);
    approx(renorm.money.annualSavings, 24000, 1e-9);
    assert(renorm.you.currentAge === 35, 'anchor synced into fire slice');
  });

  await test('prefill FIRE→retirement seeds taxable from projection and baseline from spending', () => {
    const fire = FireEngine.normalizeState(FireEngine.sampleState());
    fire.money.currentBalance = 200000;
    fire.money.annualSpending = 48000;
    const full = P.buildFullState({ origin: 'fire-calculator', fire });
    const pre = P.prefillRetirementFromFire(full);
    const expectedTaxable = Math.round(FireEngine.coastNumber(fire).projectedBalance);
    approx(pre.retirement.accounts.taxable, expectedTaxable, 1e-9, 'taxable seeded from projected balance');
    approx(pre.retirement.spending.baseline, 48000, 1e-9, 'baseline from annual spending');
    // asserted through the receiving engine's normalizeState output
    const renorm = RetirementEngine.normalizeState(pre.retirement);
    approx(renorm.accounts.taxable, expectedTaxable, 1e-9);
  });

  await test('debt engine integration: payoffProjection feeds the FIRE prefill end-to-end', () => {
    const debtState = DebtEngine.sampleState();
    const proj = DebtEngine.payoffProjection(debtState);
    assert(proj.payable && proj.months > 0);
    const full = P.buildFullState({
      origin: 'debt-calculator',
      you: { currentAge: debtState.you.currentAge },
      debts: debtState.debts,
      debtStrategy: debtState.debtStrategy,
      monthlyDebtBudget: debtState.monthlyDebtBudget
    });
    const pre = P.prefillFireFromDebt(full);
    assert(pre.months === proj.months, 'same projection drives the mapping');
    approx(pre.annualInvesting, debtState.monthlyDebtBudget * 12, 1e-9);
    assert(pre.debtFreeAge === Math.ceil(debtState.you.currentAge + proj.months / 12));
  });

  // ---- share payload hygiene --------------------------------------------------

  await test('share payloads strip meta timestamps', async () => {
    const full = P.defaultFullState();
    const parsed = await P.decompressState(await P.encodeSharePayload(full));
    assert(parsed.meta === undefined || parsed.meta.created === undefined,
      'created timestamp not shared');
  });

  // ---- report ----------------------------------------------------------------

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFailures:');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
