/*
 * Retirement calculator engine.
 *
 * Pure, DOM-free calculation core shared by retirement-calculator.html (browser)
 * and scripts/retirement-tests.js (Node). No dependencies. UMD footer exposes it
 * as `window.RetirementEngine` in the browser and `module.exports` in Node.
 *
 * Everything here is deterministic given its inputs (Monte Carlo takes a seed),
 * so the whole engine is unit-testable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RetirementEngine = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- defaults ------------------------------------------------------------

  const RMD_AGE = 73; // SECURE 2.0 first-RMD age
  // IRS Uniform Lifetime Table (2022+), age -> distribution period.
  const RMD_TABLE = {
    73:26.5, 74:25.5, 75:24.6, 76:23.7, 77:22.9, 78:22.0, 79:21.1, 80:20.2,
    81:19.4, 82:18.5, 83:17.7, 84:16.8, 85:16.0, 86:15.2, 87:14.4, 88:13.7,
    89:12.9, 90:12.2, 91:11.5, 92:10.8, 93:10.1, 94:9.5, 95:8.9, 96:8.4,
    97:7.8, 98:7.3, 99:6.8, 100:6.4, 101:6.0, 102:5.6, 103:5.2, 104:4.9,
    105:4.6, 106:4.3, 107:4.1, 108:3.9, 109:3.7, 110:3.5, 111:3.4, 112:3.3,
    113:3.1, 114:3.0, 115:2.9, 116:2.8, 117:2.7, 118:2.5, 119:2.3, 120:2.0
  };

  // Annual Medicare Part B IRMAA surcharge per tier (approx, single-ish, 2025-ish).
  const IRMAA_SURCHARGE = [0, 1000, 2500, 4000, 5500, 6600];

  const FRA = 67; // Social Security full retirement age used for the claiming factor.

  function defaultState() {
    return {
      v: 2,
      you: { currentAge: 40, retireAge: 67, endAge: 95 },
      accounts: { taxable: 50000, traditional: 150000, roth: 40000, cash: 20000, hsa: 0 },
      contributions: {
        taxable: 3000, traditional: 15000, roth: 6000, hsa: 0,
        employerMatch: 5000
      },
      income: [
        { type: 'socialSecurity', label: 'Social Security', amount: 30000, startAge: 67, cola: true },
        { type: 'pension', label: 'Pension', amount: 0, startAge: 65, cola: false },
        { type: 'other', label: 'Other income', amount: 0, startAge: 67, cola: false }
      ],
      spending: {
        mode: 'flat', // 'flat' = single amount (with optional phasing) | 'items' = itemized budget
        baseline: 70000,
        items: [], // { label, category, amount, frequency, inflation, startAge, endAge }
        phased: { enabled: false, goGo: 80000, slowGo: 65000, noGo: 55000, slowGoAge: 75, noGoAge: 85 },
        healthcare: { enabled: false, preMedicarePremium: 12000, medicareAnnual: 7000, irmaaTier: 0, medicalInflation: 0.05 },
        ltc: { enabled: false, annualCost: 100000, years: 3, startAge: 88 },
        oneOffs: [] // { label, amount, age }  (amount<0 = inflow, e.g. home sale)
      },
      assumptions: {
        returnAccum: 0.06,
        returnRetire: 0.05,
        inflation: 0.03,
        medicalInflation: 0.05,
        volatility: 0.12,
        taxRate: 0.15,
        taxableGainFraction: 0.5,
        contributionGrowth: 0.02
      },
      strategy: {
        withdrawalOrder: ['cash', 'taxable', 'traditional', 'roth', 'hsa'],
        withdrawalMethod: 'fixedReal', // 'fixedReal' | 'fourPercent' | 'guardrails'
        ssClaimAge: 67,
        monteCarloIterations: 1000
      }
    };
  }

  function sampleState() {
    const s = defaultState();
    s.you = { currentAge: 45, retireAge: 65, endAge: 92 };
    s.accounts = { taxable: 120000, traditional: 380000, roth: 90000, cash: 30000, hsa: 15000 };
    s.contributions = { taxable: 6000, traditional: 20000, roth: 7000, hsa: 4000, employerMatch: 8000 };
    s.income[0].amount = 34000;
    s.spending.mode = 'items';
    s.spending.items = [
      { label: 'Mortgage', category: 'housing', amount: 1800, frequency: 'monthly', inflation: 'fixed', startAge: null, endAge: 75 },
      { label: 'Property tax & insurance', category: 'housing', amount: 9000, frequency: 'annual', inflation: 'general', startAge: null, endAge: null },
      { label: 'Food & household', category: 'living', amount: 1600, frequency: 'monthly', inflation: 'general', startAge: null, endAge: null },
      { label: 'Travel & hobbies', category: 'leisure', amount: 12000, frequency: 'annual', inflation: 'general', startAge: null, endAge: 85 },
      { label: 'Medigap premium', category: 'living', amount: 3000, frequency: 'annual', inflation: 'medical', startAge: 65, endAge: null }
    ];
    s.spending.phased.enabled = true;
    s.spending.healthcare.enabled = true;
    s.strategy.ssClaimAge = 70;
    return s;
  }

  // ---- helpers -------------------------------------------------------------

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  const ITEM_CATEGORIES = ['housing', 'transport', 'living', 'leisure', 'other'];
  const ITEM_INFLATION = ['general', 'medical', 'fixed'];

  // Optional per-line age bounds: null/''/missing means "no bound".
  // (Guarded before clampInt because Number(null) is 0, not NaN.)
  function optionalAge(v) {
    if (v == null || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? clamp(n, 0, 120) : null;
  }

  function normalizeItem(it, i) {
    it = it && typeof it === 'object' ? it : {};
    return {
      label: String(it.label || ('Expense ' + (i + 1))),
      category: ITEM_CATEGORIES.includes(it.category) ? it.category : 'other',
      amount: Math.max(0, num(it.amount, 0)),
      frequency: it.frequency === 'monthly' ? 'monthly' : 'annual',
      inflation: ITEM_INFLATION.includes(it.inflation) ? it.inflation : 'general',
      startAge: optionalAge(it.startAge),
      endAge: optionalAge(it.endAge)
    };
  }

  // Annual-equivalent amount for a line item (the engine only ever sees annual).
  function itemAnnual(item) {
    return (item && item.amount > 0 ? item.amount : 0) * (item && item.frequency === 'monthly' ? 12 : 1);
  }

  // Deep-fill a partial/loaded state against the defaults so the engine never
  // hits an undefined field. Coerces numeric fields to finite numbers.
  function normalizeState(input) {
    const d = defaultState();
    const s = input && typeof input === 'object' ? input : {};
    const out = defaultState();

    if (s.you) {
      out.you.currentAge = clampInt(s.you.currentAge, 0, 120, d.you.currentAge);
      out.you.retireAge = clampInt(s.you.retireAge, 0, 120, d.you.retireAge);
      out.you.endAge = clampInt(s.you.endAge, 1, 120, d.you.endAge);
    }
    if (s.accounts) for (const k of Object.keys(out.accounts)) out.accounts[k] = Math.max(0, num(s.accounts[k], d.accounts[k]));
    if (s.contributions) for (const k of Object.keys(out.contributions)) out.contributions[k] = Math.max(0, num(s.contributions[k], d.contributions[k]));

    if (Array.isArray(s.income)) {
      out.income = s.income.map((inc, i) => ({
        type: String(inc && inc.type || ('other')),
        label: String(inc && inc.label || ('Income ' + (i + 1))),
        amount: Math.max(0, num(inc && inc.amount, 0)),
        startAge: clampInt(inc && inc.startAge, 0, 120, 67),
        cola: !!(inc && inc.cola)
      }));
    }

    if (s.spending) {
      const sp = s.spending;
      out.spending.mode = sp.mode === 'items' ? 'items' : 'flat';
      out.spending.baseline = Math.max(0, num(sp.baseline, d.spending.baseline));
      if (Array.isArray(sp.items)) {
        out.spending.items = sp.items.map((it, i) => normalizeItem(it, i));
      }
      if (sp.phased) {
        out.spending.phased = {
          enabled: !!sp.phased.enabled,
          goGo: Math.max(0, num(sp.phased.goGo, d.spending.phased.goGo)),
          slowGo: Math.max(0, num(sp.phased.slowGo, d.spending.phased.slowGo)),
          noGo: Math.max(0, num(sp.phased.noGo, d.spending.phased.noGo)),
          slowGoAge: clampInt(sp.phased.slowGoAge, 0, 120, d.spending.phased.slowGoAge),
          noGoAge: clampInt(sp.phased.noGoAge, 0, 120, d.spending.phased.noGoAge)
        };
      }
      if (sp.healthcare) {
        out.spending.healthcare = {
          enabled: !!sp.healthcare.enabled,
          preMedicarePremium: Math.max(0, num(sp.healthcare.preMedicarePremium, d.spending.healthcare.preMedicarePremium)),
          medicareAnnual: Math.max(0, num(sp.healthcare.medicareAnnual, d.spending.healthcare.medicareAnnual)),
          irmaaTier: clampInt(sp.healthcare.irmaaTier, 0, IRMAA_SURCHARGE.length - 1, 0),
          medicalInflation: num(sp.healthcare.medicalInflation, d.spending.healthcare.medicalInflation)
        };
      }
      if (sp.ltc) {
        out.spending.ltc = {
          enabled: !!sp.ltc.enabled,
          annualCost: Math.max(0, num(sp.ltc.annualCost, d.spending.ltc.annualCost)),
          years: clampInt(sp.ltc.years, 0, 60, d.spending.ltc.years),
          startAge: clampInt(sp.ltc.startAge, 0, 120, d.spending.ltc.startAge)
        };
      }
      if (Array.isArray(sp.oneOffs)) {
        out.spending.oneOffs = sp.oneOffs.map((o, i) => ({
          label: String(o && o.label || ('Event ' + (i + 1))),
          amount: num(o && o.amount, 0),
          age: clampInt(o && o.age, 0, 120, out.you.retireAge)
        }));
      }
    }

    if (s.assumptions) {
      const a = s.assumptions;
      out.assumptions = {
        returnAccum: num(a.returnAccum, d.assumptions.returnAccum),
        returnRetire: num(a.returnRetire, d.assumptions.returnRetire),
        inflation: num(a.inflation, d.assumptions.inflation),
        medicalInflation: num(a.medicalInflation, d.assumptions.medicalInflation),
        volatility: Math.max(0, num(a.volatility, d.assumptions.volatility)),
        taxRate: clamp(num(a.taxRate, d.assumptions.taxRate), 0, 0.9),
        taxableGainFraction: clamp(num(a.taxableGainFraction, d.assumptions.taxableGainFraction), 0, 1),
        contributionGrowth: num(a.contributionGrowth, d.assumptions.contributionGrowth)
      };
    }

    if (s.strategy) {
      const st = s.strategy;
      const order = Array.isArray(st.withdrawalOrder) && st.withdrawalOrder.length
        ? st.withdrawalOrder.filter(k => out.accounts.hasOwnProperty(k))
        : d.strategy.withdrawalOrder.slice();
      // guarantee every account is somewhere in the order
      for (const k of d.strategy.withdrawalOrder) if (order.indexOf(k) === -1) order.push(k);
      out.strategy = {
        withdrawalOrder: order,
        withdrawalMethod: ['fixedReal', 'fourPercent', 'guardrails'].indexOf(st.withdrawalMethod) >= 0 ? st.withdrawalMethod : d.strategy.withdrawalMethod,
        ssClaimAge: clampInt(st.ssClaimAge, 62, 70, d.strategy.ssClaimAge),
        monteCarloIterations: clampInt(st.monteCarloIterations, 100, 20000, d.strategy.monteCarloIterations)
      };
    }

    return out;
  }

  function clamp(n, lo, hi) { n = num(n, lo); return Math.min(hi, Math.max(lo, n)); }
  function clampInt(n, lo, hi, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  }

  function validate(S) {
    const issues = [];
    if (S.you.retireAge < S.you.currentAge) issues.push('Retirement age is before your current age — treated as already retired.');
    if (S.you.endAge <= S.you.retireAge) issues.push('End-of-plan age must be after retirement age.');
    if (S.you.endAge <= S.you.currentAge) issues.push('End-of-plan age must be after your current age.');
    if (S.spending.phased.enabled && S.spending.phased.noGoAge < S.spending.phased.slowGoAge) {
      issues.push('Phased spending: the "no-go" age should not be before the "slow-go" age.');
    }
    if (S.spending.mode === 'items' && (!Array.isArray(S.spending.items) || S.spending.items.length === 0)) {
      issues.push('Itemized spending is selected but the expense list is empty — yearly living costs are zero until you add line items.');
    }
    return issues;
  }

  // ---- financial primitives ------------------------------------------------

  function totalAll(bal) {
    return bal.taxable + bal.traditional + bal.roth + bal.cash + bal.hsa;
  }

  function rmdRequired(age, traditionalBalance) {
    if (age < RMD_AGE || traditionalBalance <= 0) return 0;
    const factor = RMD_TABLE[age] || RMD_TABLE[120];
    return traditionalBalance / factor;
  }

  // Social Security benefit multiplier for claiming at `claimAge` relative to FRA.
  function ssFactor(claimAge, fra) {
    fra = fra || FRA;
    if (claimAge === fra) return 1;
    if (claimAge < fra) {
      const months = (fra - claimAge) * 12;
      const first36 = Math.min(months, 36);
      const beyond = Math.max(0, months - 36);
      return Math.max(0, 1 - first36 * (5 / 9) / 100 - beyond * (5 / 12) / 100);
    }
    const months = (Math.min(claimAge, 70) - fra) * 12;
    return 1 + months * (2 / 3) / 100; // +8%/yr delayed credit
  }

  function irmaaSurcharge(tier) {
    return IRMAA_SURCHARGE[clampInt(tier, 0, IRMAA_SURCHARGE.length - 1, 0)];
  }

  function spendingForYear(S, age, t) {
    const sp = S.spending;
    const infl = S.assumptions.inflation;
    const minfl = sp.healthcare.medicalInflation;
    let total = baselineComponent(S, age, t);

    if (sp.healthcare.enabled) {
      const hc = age < 65
        ? sp.healthcare.preMedicarePremium
        : sp.healthcare.medicareAnnual + irmaaSurcharge(sp.healthcare.irmaaTier);
      total += hc * Math.pow(1 + minfl, t);
    }
    if (sp.ltc.enabled && age >= sp.ltc.startAge && age < sp.ltc.startAge + sp.ltc.years) {
      total += sp.ltc.annualCost * Math.pow(1 + minfl, t);
    }
    for (const o of sp.oneOffs) {
      if (o.age === age) total += o.amount * Math.pow(1 + infl, t);
    }
    return total;
  }

  function incomeForYear(S, age, t) {
    const infl = S.assumptions.inflation;
    let total = 0;
    for (const inc of S.income) {
      let startAge = inc.startAge;
      let amt = inc.amount;
      if (inc.type === 'socialSecurity') {
        startAge = S.strategy.ssClaimAge;
        amt = inc.amount * ssFactor(startAge, FRA);
      }
      if (age >= startAge && amt > 0) {
        total += inc.cola ? amt * Math.pow(1 + infl, t) : amt;
      }
    }
    return total;
  }

  // Pull `need` (net, after-tax dollars) from accounts in order, grossing up for
  // taxes, then enforce any RMD. Mutates `bal`.
  function withdraw(bal, need, S, rmd) {
    const order = S.strategy.withdrawalOrder;
    const taxRate = S.assumptions.taxRate;
    const gainFrac = S.assumptions.taxableGainFraction;
    let remaining = need, tax = 0, gross = 0, fromTrad = 0;

    for (const acct of order) {
      if (remaining <= 1e-9) break;
      const avail = bal[acct];
      if (avail <= 0) continue;
      const effRate = acct === 'traditional' ? taxRate
        : acct === 'taxable' ? taxRate * gainFrac
          : 0; // roth, cash, hsa untaxed in this model
      const grossNeeded = remaining / (1 - effRate);
      const grossTake = Math.min(grossNeeded, avail);
      const net = grossTake * (1 - effRate);
      bal[acct] -= grossTake;
      tax += grossTake * effRate;
      gross += grossTake;
      remaining -= net;
      if (acct === 'traditional') fromTrad += grossTake;
    }

    const fullyFunded = remaining <= 1e-6;

    // RMD enforcement: if discretionary traditional withdrawal fell short of the
    // RMD, take the difference (taxed) and reinvest the net into taxable.
    const rmdExtra = Math.max(0, rmd - fromTrad);
    if (rmdExtra > 0 && bal.traditional > 0) {
      const take = Math.min(rmdExtra, bal.traditional);
      bal.traditional -= take;
      const t2 = take * taxRate;
      tax += t2;
      gross += take;
      bal.taxable += take - t2;
    }

    return { fullyFunded, tax, gross, shortfall: Math.max(0, remaining) };
  }

  // ---- core simulation -----------------------------------------------------

  // Run a single path. `returnFn(t, isRetired)` supplies the nominal return for
  // year index t. Returns per-year rows plus summary. All figures nominal.
  function simulatePath(S, returnFn) {
    const bal = {
      taxable: S.accounts.taxable, traditional: S.accounts.traditional,
      roth: S.accounts.roth, cash: S.accounts.cash, hsa: S.accounts.hsa
    };
    const rows = [];
    let depletionAge = null;
    let success = true;
    let fourPctBase = null;
    let guardW = null; // current nominal guardrails withdrawal
    let guardInitRate = null;
    let prevReturn = null; // last year's realized return (for the guardrails rule)
    const tRet = Math.max(0, S.you.retireAge - S.you.currentAge);
    const infl = S.assumptions.inflation;
    const cg = S.assumptions.contributionGrowth;

    for (let age = S.you.currentAge, t = 0; age <= S.you.endAge; age++, t++) {
      const isRetired = age >= S.you.retireAge;
      const r = returnFn(t, isRetired);
      let income = 0, spendingNeed = 0, taxesPaid = 0, withdrawal = 0, lastReturn = r;

      if (!isRetired) {
        const g = Math.pow(1 + cg, t);
        bal.taxable += S.contributions.taxable * g;
        bal.traditional += (S.contributions.traditional + S.contributions.employerMatch) * g;
        bal.roth += S.contributions.roth * g;
        bal.hsa += S.contributions.hsa * g;
        growAll(bal, r);
      } else {
        if (fourPctBase === null) fourPctBase = totalAll(bal);

        const rawSpend = spendingForYear(S, age, t);
        income = incomeForYear(S, age, t);

        // Discretionary target depends on withdrawal method; healthcare/LTC/one-offs
        // are handled inside spendingForYear, so methods only reshape the baseline.
        let targetSpend = rawSpend;
        if (S.strategy.withdrawalMethod === 'fourPercent' && fourPctBase > 0) {
          const baseAtRet = fourPctBase * 0.04;
          const discretionary = baseAtRet * Math.pow(1 + infl, t - tRet);
          targetSpend = discretionary + (rawSpend - baselineComponent(S, age, t));
        } else if (S.strategy.withdrawalMethod === 'guardrails') {
          const portfolio = totalAll(bal);
          if (guardW === null) {
            guardW = baselineComponent(S, age, t);
            guardInitRate = portfolio > 0 ? guardW / portfolio : 0;
          } else {
            let tentative = guardW;
            const rate = portfolio > 0 ? guardW / portfolio : 0;
            // capital-preservation: skip the inflation raise after last year was down if overspending
            if (!(prevReturn != null && prevReturn < 0 && rate > guardInitRate)) tentative = guardW * (1 + infl);
            if (guardInitRate > 0 && rate > 1.2 * guardInitRate) tentative *= 0.9;      // guardrail cut
            else if (guardInitRate > 0 && rate < 0.8 * guardInitRate) tentative *= 1.1; // prosperity raise
            guardW = tentative;
          }
          targetSpend = guardW + (rawSpend - baselineComponent(S, age, t));
        }

        spendingNeed = targetSpend;
        let need = targetSpend - income;
        if (need < 0) { bal.taxable += -need; need = 0; } // surplus income reinvested

        const rmd = rmdRequired(age, bal.traditional);
        const res = withdraw(bal, need, S, rmd);
        taxesPaid = res.tax;
        withdrawal = res.gross;
        if (!res.fullyFunded) {
          success = false;
          if (depletionAge === null) depletionAge = age;
        }
        growAll(bal, r);
      }

      rows.push({
        age, t, isRetired,
        taxable: bal.taxable, traditional: bal.traditional, roth: bal.roth,
        cash: bal.cash, hsa: bal.hsa,
        income, spending: spendingNeed, withdrawal, taxes: taxesPaid,
        total: totalAll(bal), return: lastReturn
      });
      prevReturn = r; // remembered for next year's guardrails decision
    }

    return { rows, depletionAge, success, endBalance: rows.length ? rows[rows.length - 1].total : totalAll(bal) };
  }

  // The pure baseline component: itemized budget when items mode is active,
  // otherwise the single flat amount (with optional phasing). Both inflated
  // to year t. Healthcare/LTC/one-offs are added on top by spendingForYear.
  function baselineComponent(S, age, t) {
    const sp = S.spending;
    if (usingItems(sp)) return itemsForYear(S, age, t);
    let base;
    if (sp.phased.enabled) {
      if (age < sp.phased.slowGoAge) base = sp.phased.goGo;
      else if (age < sp.phased.noGoAge) base = sp.phased.slowGo;
      else base = sp.phased.noGo;
    } else {
      base = sp.baseline;
    }
    return base * Math.pow(1 + S.assumptions.inflation, t);
  }

  function usingItems(sp) {
    return sp.mode === 'items' && Array.isArray(sp.items) && sp.items.length > 0;
  }

  // Sum of the enabled age-window line items for one plan year. Each line
  // inflates at its own rate: 'fixed' never grows (nominal payment like a
  // fixed-rate mortgage), 'medical' uses medical inflation, everything else
  // uses general inflation.
  function itemsForYear(S, age, t) {
    const sp = S.spending;
    let total = 0;
    for (const it of sp.items) {
      if (it.startAge != null && age < it.startAge) continue;
      if (it.endAge != null && age > it.endAge) continue;
      const rate = it.inflation === 'fixed' ? 0
        : it.inflation === 'medical' ? sp.healthcare.medicalInflation
        : S.assumptions.inflation;
      total += itemAnnual(it) * Math.pow(1 + rate, t);
    }
    return total;
  }

  function growAll(bal, r) {
    bal.taxable *= (1 + r);
    bal.traditional *= (1 + r);
    bal.roth *= (1 + r);
    bal.cash *= (1 + r);
    bal.hsa *= (1 + r);
  }

  // Deterministic single-path projection using the flat return assumptions.
  function projectDeterministic(state) {
    const S = normalizeState(state);
    const returnFn = (t, isRetired) => isRetired ? S.assumptions.returnRetire : S.assumptions.returnAccum;
    const res = simulatePath(S, returnFn);
    return { state: S, ...res };
  }

  // Project against an explicit per-year nominal return sequence (for the
  // sequence-of-returns demonstration).
  function projectWithReturns(state, returns) {
    const S = normalizeState(state);
    const returnFn = (t) => (t < returns.length ? returns[t] : (returns.length ? returns[returns.length - 1] : 0));
    return { state: S, ...simulatePath(S, returnFn) };
  }

  // ---- Monte Carlo ---------------------------------------------------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeGaussian(rand) {
    let spare = null;
    return function () {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u, v, s;
      do { u = rand() * 2 - 1; v = rand() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
      const mul = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * mul;
      return u * mul;
    };
  }

  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 0;
    const idx = (p / 100) * (sortedAsc.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedAsc[lo];
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  }

  function runMonteCarlo(state, opts) {
    opts = opts || {};
    const S = normalizeState(state);
    const iterations = clampInt(opts.iterations != null ? opts.iterations : S.strategy.monteCarloIterations, 100, 50000, 1000);
    const rng = mulberry32(opts.seed != null ? opts.seed : 0x9e3779b9);
    const gauss = makeGaussian(rng);
    const vol = S.assumptions.volatility;
    const years = S.you.endAge - S.you.currentAge + 1;

    const terminals = [];
    const depletionAges = [];
    let successes = 0;
    // per-year totals for the fan chart
    const byYear = [];
    for (let i = 0; i < years; i++) byYear.push([]);

    for (let k = 0; k < iterations; k++) {
      const returnFn = (t, isRetired) => {
        const mean = isRetired ? S.assumptions.returnRetire : S.assumptions.returnAccum;
        return mean + vol * gauss();
      };
      const res = simulatePath(S, returnFn);
      if (res.success) successes++; else depletionAges.push(res.depletionAge);
      terminals.push(res.endBalance);
      for (let i = 0; i < res.rows.length; i++) byYear[i].push(res.rows[i].total);
    }

    terminals.sort((a, b) => a - b);
    const bands = byYear.map((arr, i) => {
      const sorted = arr.slice().sort((a, b) => a - b);
      return {
        age: S.you.currentAge + i,
        p10: percentile(sorted, 10),
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90)
      };
    });

    return {
      state: S,
      iterations,
      successRate: successes / iterations,
      terminal: { p10: percentile(terminals, 10), p50: percentile(terminals, 50), p90: percentile(terminals, 90) },
      medianDepletionAge: depletionAges.length ? Math.round(median(depletionAges)) : null,
      failureCount: iterations - successes,
      bands
    };
  }

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function verdict(rate) {
    if (rate >= 0.9) return { label: 'Very likely', tone: 'good' };
    if (rate >= 0.75) return { label: 'Likely', tone: 'good' };
    if (rate >= 0.5) return { label: 'Borderline', tone: 'warn' };
    return { label: 'At risk', tone: 'bad' };
  }

  // ---- share-link codec (compact array form) -------------------------------

  function compactState(state) {
    const S = normalizeState(state);
    const a = S.assumptions, y = S.you, ac = S.accounts, c = S.contributions,
      sp = S.spending, ph = sp.phased, hc = sp.healthcare, ltc = sp.ltc, st = S.strategy;
    return {
      v: 2,
      y: [y.currentAge, y.retireAge, y.endAge],
      ac: [ac.taxable, ac.traditional, ac.roth, ac.cash, ac.hsa],
      c: [c.taxable, c.traditional, c.roth, c.hsa, c.employerMatch],
      i: S.income.map(x => [x.type, x.label, x.amount, x.startAge, x.cola ? 1 : 0]),
      sp: [sp.baseline],
      spm: [sp.mode],
      si: sp.items.map(it => [
        it.label, it.category, it.amount, it.frequency, it.inflation,
        it.startAge == null ? '' : it.startAge,
        it.endAge == null ? '' : it.endAge
      ]),
      ph: [ph.enabled ? 1 : 0, ph.goGo, ph.slowGo, ph.noGo, ph.slowGoAge, ph.noGoAge],
      hc: [hc.enabled ? 1 : 0, hc.preMedicarePremium, hc.medicareAnnual, hc.irmaaTier, hc.medicalInflation],
      lt: [ltc.enabled ? 1 : 0, ltc.annualCost, ltc.years, ltc.startAge],
      oo: sp.oneOffs.map(o => [o.label, o.amount, o.age]),
      a: [a.returnAccum, a.returnRetire, a.inflation, a.medicalInflation, a.volatility, a.taxRate, a.taxableGainFraction, a.contributionGrowth],
      st: [st.withdrawalMethod, st.ssClaimAge, st.monteCarloIterations, st.withdrawalOrder.join('|')]
    };
  }

  function expandState(d) {
    if (!d || (d.v !== 1 && d.v !== 2) || !Array.isArray(d.y)) return d; // unknown form; hand back as-is
    const out = defaultState();
    out.you = { currentAge: d.y[0], retireAge: d.y[1], endAge: d.y[2] };
    if (Array.isArray(d.ac)) out.accounts = { taxable: d.ac[0], traditional: d.ac[1], roth: d.ac[2], cash: d.ac[3], hsa: d.ac[4] };
    if (Array.isArray(d.c)) out.contributions = { taxable: d.c[0], traditional: d.c[1], roth: d.c[2], hsa: d.c[3], employerMatch: d.c[4] };
    if (Array.isArray(d.i)) out.income = d.i.map(x => ({ type: x[0], label: x[1], amount: x[2], startAge: x[3], cola: !!x[4] }));
    if (Array.isArray(d.sp)) out.spending.baseline = d.sp[0];
    if (d.v === 2) {
      // v2 adds the itemized budget; v1 payloads keep the flat-mode defaults.
      if (Array.isArray(d.spm)) out.spending.mode = d.spm[0] === 'items' ? 'items' : 'flat';
      if (Array.isArray(d.si)) {
        out.spending.items = d.si.map(x => ({
          label: x[0], category: x[1], amount: x[2], frequency: x[3], inflation: x[4],
          startAge: x[5] === '' || x[5] == null ? null : Number(x[5]),
          endAge: x[6] === '' || x[6] == null ? null : Number(x[6])
        }));
      }
    }
    if (Array.isArray(d.ph)) out.spending.phased = { enabled: !!d.ph[0], goGo: d.ph[1], slowGo: d.ph[2], noGo: d.ph[3], slowGoAge: d.ph[4], noGoAge: d.ph[5] };
    if (Array.isArray(d.hc)) out.spending.healthcare = { enabled: !!d.hc[0], preMedicarePremium: d.hc[1], medicareAnnual: d.hc[2], irmaaTier: d.hc[3], medicalInflation: d.hc[4] };
    if (Array.isArray(d.lt)) out.spending.ltc = { enabled: !!d.lt[0], annualCost: d.lt[1], years: d.lt[2], startAge: d.lt[3] };
    if (Array.isArray(d.oo)) out.spending.oneOffs = d.oo.map(o => ({ label: o[0], amount: o[1], age: o[2] }));
    if (Array.isArray(d.a)) out.assumptions = {
      returnAccum: d.a[0], returnRetire: d.a[1], inflation: d.a[2], medicalInflation: d.a[3],
      volatility: d.a[4], taxRate: d.a[5], taxableGainFraction: d.a[6], contributionGrowth: d.a[7]
    };
    if (Array.isArray(d.st)) out.strategy = {
      withdrawalMethod: d.st[0], ssClaimAge: d.st[1], monteCarloIterations: d.st[2],
      withdrawalOrder: String(d.st[3] || '').split('|').filter(Boolean)
    };
    return normalizeState(out);
  }

  return {
    // state
    defaultState, sampleState, normalizeState, validate,
    // primitives (exported for testing)
    rmdRequired, ssFactor, irmaaSurcharge, spendingForYear, incomeForYear,
    withdraw, totalAll, percentile, verdict,
    itemAnnual, itemsForYear, baselineComponent,
    // simulation
    simulatePath, projectDeterministic, projectWithReturns, runMonteCarlo,
    // share codec
    compactState, expandState,
    // constants
    RMD_AGE, FRA, IRMAA_SURCHARGE
  };
}));
