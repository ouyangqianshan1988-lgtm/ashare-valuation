import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../site/valuation.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

const company = (overrides = {}) => ({
  code: '600000', name: '测试公司', method: 'fcff', price: 10, quoteDate: '2026-09-16',
  financials: {
    revenue: 1000, ebit: 100, taxRate: 0.25, depreciation: 0, capex: 0,
    workingCapital: 0, cash: 0, debt: 0, minorityInterest: 0, shares: 100,
    reportDate: '2025-12-31', ...(overrides.financials ?? {}),
  }, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'financials')),
});

const assumptions = (overrides = {}) => ({
  scenarios: [
    { name: 'bear', probability: 0.2, growth: 0, margin: 0.1, taxRate: 0.25, daRatio: 0, capexRatio: 0, nwcRatio: 0, wacc: 0.1, terminalGrowth: 0, terminalRoic: 0.12 },
    { name: 'base', probability: 0.5, growth: 0, margin: 0.1, taxRate: 0.25, daRatio: 0, capexRatio: 0, nwcRatio: 0, wacc: 0.1, terminalGrowth: 0, terminalRoic: 0.12 },
    { name: 'bull', probability: 0.3, growth: 0, margin: 0.1, taxRate: 0.25, daRatio: 0, capexRatio: 0, nwcRatio: 0, wacc: 0.1, terminalGrowth: 0, terminalRoic: 0.12 },
  ], advantageYears: 5, sustainedGrowth: 0, ...overrides,
});

test('constant FCFF matches an independent perpetuity result', () => {
  const result = evaluate(company(), assumptions());
  assert.equal(result.status, 'DRAFT_REVIEW');
  assert.equal(result.scenarios.length, 3);
  assert.ok(Math.abs(result.scenarios[1].enterpriseValue - 750) < 1e-9);
  assert.ok(Math.abs(result.scenarios[1].valuePerShare - 7.5) < 1e-9);
  assert.equal(result.scenarios[1].forecast.length, 5);
  assert.ok(Math.abs(result.weightedValue - 7.5) < 1e-9);
});

test('accepts explicit zero but blocks a missing required fact', () => {
  assert.equal(evaluate(company(), assumptions()).status, 'DRAFT_REVIEW');
  const missing = company();
  delete missing.financials.cash;
  const result = evaluate(missing, assumptions());
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.errors.some((error) => error.code === 'MISSING_FACT'));
});

test('bridges enterprise value to equity and divides by shares', () => {
  const result = evaluate(company({ financials: { cash: 40, debt: 20, minorityInterest: 10, shares: 50 } }), assumptions());
  assert.ok(Math.abs(result.scenarios[0].equityValue - 760) < 1e-9);
  assert.ok(Math.abs(result.scenarios[0].valuePerShare - 15.2) < 1e-9);
});

test('blocks invalid probability totals and invalid rates', () => {
  const badProbability = assumptions();
  badProbability.scenarios[0].probability = 0.4;
  assert.ok(evaluate(company(), badProbability).errors.some((e) => e.code === 'PROBABILITY_TOTAL'));
  const badRate = assumptions();
  badRate.scenarios[1].terminalGrowth = 0.1;
  assert.ok(evaluate(company(), badRate).errors.some((e) => e.code === 'WACC_NOT_ABOVE_GROWTH'));
});

test('higher WACC produces a lower value', () => {
  const a = assumptions();
  a.scenarios[0].wacc = 0.08;
  a.scenarios[1].wacc = 0.1;
  a.scenarios[2].wacc = 0.12;
  const values = evaluate(company(), a).scenarios.map((s) => s.valuePerShare);
  assert.ok(values[0] > values[1] && values[1] > values[2]);
});

test('reverse perpetual solver recovers a known market-implied growth rate', () => {
  const explicitPv = 75 * (1 - 1 / 1.1 ** 5) / 0.1;
  const terminalPv = (1000 * 1.02 * 0.1 * 0.75 * (1 - 0.02 / 0.12) / (0.1 - 0.02)) / 1.1 ** 5;
  const input = company({ price: (explicitPv + terminalPv) / 100 });
  const result = evaluate(input, assumptions());
  assert.equal(result.reverse.terminalGrowth.status, 'SOLVED');
  assert.ok(Math.abs(result.reverse.impliedTerminalGrowth - 0.02) < 1e-6);
});

test('duration inversion reports unreachable explicitly', () => {
  const unreachable = evaluate(company({ price: 1000 }), assumptions());
  assert.equal(unreachable.reverse.duration.status, 'UNREACHABLE');
});

test('blocks unsuitable methods, negative terminal cash flow, and inconsistent terminal reinvestment', () => {
  assert.equal(evaluate(company({ method: 'financial' }), assumptions()).status, 'BLOCKED');
  const negative = assumptions();
  negative.scenarios[1].margin = -0.1;
  assert.ok(evaluate(company(), negative).errors.some((e) => e.code === 'NEGATIVE_TERMINAL_FCFF'));
  const inconsistent = assumptions();
  inconsistent.scenarios[1].terminalRoic = 0;
  inconsistent.scenarios[1].terminalGrowth = 0.02;
  assert.ok(evaluate(company(), inconsistent).errors.some((e) => e.code === 'TERMINAL_REINVESTMENT'));
});

test('does not provide PEG without forward consensus', () => {
  const result = evaluate(company(), assumptions());
  assert.equal(result.peg, undefined);
});

test('zero terminal growth permits zero terminal ROIC without producing NaN', () => {
  const input = assumptions();
  for (const scenario of input.scenarios) scenario.terminalRoic = 0;
  const result = evaluate(company(), input);
  assert.equal(result.status, 'DRAFT_REVIEW');
  assert.ok(Number.isFinite(result.weightedValue));
});

test('blocks missing market metadata and a nonfinite market price', () => {
  const missing = company();
  delete missing.quoteDate;
  assert.ok(evaluate(missing, assumptions()).errors.some((e) => e.path === 'company.quoteDate'));
  assert.ok(evaluate(company({ price: Number.NaN }), assumptions()).errors.some((e) => e.path === 'company.price'));
});

test('year-one delta NWC bridges from reported working capital to projected NWC', () => {
  const input = assumptions();
  for (const scenario of input.scenarios) scenario.nwcRatio = 0.2;
  const result = evaluate(company({ financials: { workingCapital: 50 } }), input);
  assert.equal(result.scenarios[1].forecast[0].deltaNwc, 150);
  assert.equal(result.scenarios[1].forecast[1].deltaNwc, 0);
});

test('duration inversion preserves five base years then extends at sustained growth', () => {
  const input = assumptions({ advantageYears: 6, sustainedGrowth: 0.03 });
  input.scenarios[1] = { ...input.scenarios[1], growth: 0.1, terminalGrowth: 0.01, terminalRoic: 0.12 };
  let revenue = 1000;
  let ev = 0;
  for (let year = 1; year <= 5; year += 1) {
    revenue *= 1.1;
    ev += revenue * 0.075 / 1.1 ** year;
  }
  for (let year = 6; year <= 8; year += 1) {
    revenue *= 1.03;
    ev += revenue * 0.075 / 1.1 ** year;
  }
  const terminalFcff = revenue * 1.01 * 0.1 * 0.75 * (1 - 0.01 / 0.12);
  ev += terminalFcff / (0.1 - 0.01) / 1.1 ** 8;
  const result = evaluate(company({ price: ev / 100 }), input);
  assert.equal(result.reverse.duration.status, 'SOLVED');
  assert.ok(Math.abs(result.reverse.impliedDurationYears - 8) < 1e-5);
  assert.equal(result.reverse.duration.comparison, 'ABOVE_ASSUMPTION');
  assert.ok(result.warnings.some((warning) => warning.code === 'GROWTH_DURATION_ABOVE_ASSUMPTION'));
});

test('sustained growth may exceed WACC because it applies only for a finite extension', () => {
  const result = evaluate(company(), assumptions({ sustainedGrowth: 0.18 }));
  assert.equal(result.status, 'DRAFT_REVIEW');
});

test('blocks invalid factual bounds and dates while allowing negative minority interest', () => {
  for (const [field, value] of [['cash', -1], ['debt', -1], ['depreciation', -1], ['capex', -1], ['taxRate', 1.1]]) {
    const result = evaluate(company({ financials: { [field]: value } }), assumptions());
    assert.equal(result.status, 'BLOCKED', field);
  }
  assert.equal(evaluate(company({ financials: { minorityInterest: -10 } }), assumptions()).status, 'DRAFT_REVIEW');
  assert.equal(evaluate(company({ quoteDate: 'not-a-date' }), assumptions()).status, 'BLOCKED');
  assert.equal(evaluate(company({ financials: { reportDate: '2025-99-99' } }), assumptions()).status, 'BLOCKED');
});

test('blocks non-finite computed outputs caused by overflow', () => {
  const result = evaluate(company({ financials: { revenue: 1e308 } }), assumptions({
    scenarios: assumptions().scenarios.map((scenario) => ({ ...scenario, growth: 1 })),
  }));
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.errors.some((e) => e.code === 'NUMERIC_OVERFLOW'));
});

test('returns review warnings for concentration, evidence, ROIC, and negative explicit FCFF', () => {
  const concentrated = assumptions();
  for (const scenario of concentrated.scenarios) scenario.wacc = 0.05;
  const ordinary = evaluate(company({ historical: { roic: 0.03 } }), concentrated);
  const ordinaryCodes = new Set(ordinary.warnings.map((warning) => warning.code));
  assert.ok(ordinaryCodes.has('INDEPENDENT_REVIEW_REQUIRED'));
  assert.ok(ordinaryCodes.has('TERMINAL_VALUE_CONCENTRATION'));
  assert.ok(ordinaryCodes.has('HISTORICAL_ROIC_BELOW_WACC'));

  const input = assumptions({ advantageYears: 0 });
  for (const scenario of input.scenarios) {
    scenario.capexRatio = 0.2;
    scenario.terminalGrowth = -0.01;
  }
  const result = evaluate(company({ price: 0 }), input);
  assert.equal(result.status, 'DRAFT_REVIEW');
  const codes = new Set(result.warnings.map((warning) => warning.code));
  assert.ok(codes.has('INDEPENDENT_REVIEW_REQUIRED'));
  assert.ok(codes.has('NEGATIVE_EXPLICIT_FCFF'));
});

test('reverse growth finds roots across a non-monotonic low-ROIC domain', () => {
  const input = assumptions();
  input.scenarios[1].terminalRoic = 0.08;
  const result = evaluate(company({ price: 7.296260190871212 }), input);
  assert.equal(result.reverse.terminalGrowth.status, 'AMBIGUOUS');
  assert.equal(result.reverse.impliedTerminalGrowth, null);
  assert.ok(result.reverse.terminalGrowth.roots.some((root) => Math.abs(root - 0.02) < 1e-6));
  assert.ok(result.warnings.some((warning) => warning.code === 'AMBIGUOUS_TERMINAL_GROWTH'));
});

test('reverse growth with non-positive ROIC only admits zero growth', () => {
  for (const roic of [0, -0.1]) {
    const input = assumptions();
    input.scenarios[1].terminalRoic = roic;
    const solved = evaluate(company({ price: 7.5 }), input);
    assert.equal(solved.reverse.terminalGrowth.status, 'SOLVED');
    assert.equal(solved.reverse.impliedTerminalGrowth, 0);
    assert.deepEqual(solved.reverse.terminalGrowth.roots, [0]);

    const unreachable = evaluate(company({ price: 8 }), input);
    assert.equal(unreachable.reverse.terminalGrowth.status, 'UNREACHABLE');
    assert.equal(unreachable.reverse.impliedTerminalGrowth, null);
  }
});

test('annual paths price independently specified cash flows and terminal margin', () => {
  const input = assumptions();
  for (const s of input.scenarios) Object.assign(s, {
    revenuePath: [2500, 3000, 3200, 3500, 3600], marginPath: [0.05, 0.08, 0.1, 0.12, 0.15],
    daRatio: 0.02, capexRatio: 0.03, nwcRatio: 0.1, terminalGrowth: 0.02,
  });
  const original = structuredClone(input);
  const result = evaluate(company({ financials: { workingCapital: 100 } }), input);
  assert.equal(result.status, 'DRAFT_REVIEW');
  const base = result.scenarios[1];
  const cashFlows = [-81.25, 100, 188, 250, 359];
  const explicit = cashFlows.reduce((sum, cf, i) => sum + cf / 1.1 ** (i + 1), 0);
  const terminal = 3600 * 1.02 * 0.15 * 0.75 * (1 - 0.02 / 0.12);
  assert.deepEqual(base.forecast.map(y => y.revenue), input.scenarios[1].revenuePath);
  base.forecast.forEach((y, i) => close(y.fcff, cashFlows[i]));
  close(base.pvExplicit, explicit);
  close(base.terminalFcff, terminal);
  close(base.pvTerminal, terminal / 0.08 / 1.1 ** 5);
  close(result.sensitivity.values[2][2], base.valuePerShare);
  const recovered = evaluate(company({ price: base.valuePerShare, financials: { workingCapital: 100 } }), input);
  close(recovered.reverse.impliedTerminalGrowth, 0.02);
  close(recovered.reverse.impliedDurationYears, 5);
  assert.deepEqual(input, original);
});

test('invalid supplied paths block including sparse arrays and non-numeric entries', () => {
  for (const field of ['revenuePath', 'marginPath']) {
    const invalid = [undefined, null, {}, [], [1, 1, 1, 1], [1, 1, 1, 1, 1, 1], Array(5), [1, 1, 1, 1, NaN], [1, 1, 1, 1, Infinity], [1, 1, 1, 1, '0.1']];
    invalid.push(field === 'revenuePath' ? [1, 1, 1, 1, 0] : [0, 0, 0, 0, 1.01]);
    invalid.push(field === 'revenuePath' ? [1, 1, 1, 1, -1] : [0, 0, 0, 0, -1.01]);
    for (const path of invalid) {
      const input = assumptions();
      input.scenarios[1][field] = path;
      const result = evaluate(company(), input);
      assert.equal(result.status, 'BLOCKED', `${field}: ${String(path)}`);
      assert.ok(result.errors.some(e => e.path === `assumptions.scenarios.1.${field}`));
    }
  }
});

test('paths are independently optional while uniform growth limits remain enforced', () => {
  const input = assumptions();
  input.scenarios[0].revenuePath = [3000, 3000, 3000, 3000, 3000];
  input.scenarios[1].marginPath = [-1, 0, 0.2, 0.3, 1];
  const result = evaluate(company(), input);
  assert.equal(result.status, 'DRAFT_REVIEW');
  close(result.scenarios[0].valuePerShare, 22.5);
  assert.deepEqual(result.scenarios[1].forecast.map(y => y.ebit), [-1000, 0, 200, 300, 1000]);
  close(result.scenarios[2].valuePerShare, 7.5);
  input.scenarios[0].growth = 1.01;
  assert.equal(evaluate(company(), input).status, 'BLOCKED');
});

test('duration extension preserves annual paths and fifth-year economics', () => {
  const input = assumptions({ advantageYears: 8, sustainedGrowth: 0.03 });
  Object.assign(input.scenarios[1], { revenuePath: [1200, 1400, 1500, 1600, 1700], marginPath: [0.05, 0.06, 0.08, 0.12, 0.2], terminalGrowth: 0.01 });
  let ev = [45, 63, 90, 144, 255].reduce((sum, cf, i) => sum + cf / 1.1 ** (i + 1), 0);
  for (let year = 6; year <= 8; year++) ev += 1700 * 1.03 ** (year - 5) * 0.15 / 1.1 ** year;
  ev += 1700 * 1.03 ** 3 * 1.01 * 0.15 * (1 - 0.01 / 0.12) / 0.09 / 1.1 ** 8;
  const result = evaluate(company({ price: ev / 100 }), input);
  assert.equal(result.reverse.duration.status, 'SOLVED');
  close(result.reverse.impliedDurationYears, 8);
});
