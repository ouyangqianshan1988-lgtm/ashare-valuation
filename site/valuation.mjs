const FACTS = ['revenue', 'ebit', 'taxRate', 'depreciation', 'capex', 'workingCapital', 'cash', 'debt', 'minorityInterest', 'shares', 'reportDate'];
const SCENARIO_FIELDS = ['probability', 'growth', 'margin', 'taxRate', 'daRatio', 'capexRatio', 'nwcRatio', 'wacc', 'terminalGrowth', 'terminalRoic'];
const EPS = 1e-9;

const error = (code, message, path) => ({ code, message, ...(path ? { path } : {}) });
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const validDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

function validate(company, assumptions) {
  const errors = [];
  if (!company || typeof company !== 'object') return [error('MISSING_COMPANY', 'Company input is required.')];
  if (company.method !== 'fcff') errors.push(error('UNSUITABLE_METHOD', 'Only ordinary operating companies using FCFF are calculable.', 'company.method'));
  for (const field of ['code', 'name', 'quoteDate']) {
    if (typeof company[field] !== 'string' || company[field].trim() === '') errors.push(error('MISSING_FACT', `Missing required company field: ${field}.`, `company.${field}`));
  }
  if (!finite(company.price) || company.price < 0) errors.push(error('INVALID_BOUND', 'Market price must be a finite non-negative number.', 'company.price'));
  if (!company.financials || typeof company.financials !== 'object') return [...errors, error('MISSING_FACT', 'Financial facts are required.', 'company.financials')];
  for (const field of FACTS) {
    const value = company.financials[field];
    if (value === undefined || value === null || value === '') errors.push(error('MISSING_FACT', `Missing required fact: ${field}.`, `company.financials.${field}`));
    else if (field !== 'reportDate' && !finite(value)) errors.push(error('NONFINITE_VALUE', `${field} must be finite.`, `company.financials.${field}`));
  }
  if (finite(company.financials.revenue) && company.financials.revenue <= 0) errors.push(error('INVALID_BOUND', 'Revenue must be positive.', 'company.financials.revenue'));
  if (finite(company.financials.shares) && company.financials.shares <= 0) errors.push(error('INVALID_BOUND', 'Shares must be positive.', 'company.financials.shares'));
  for (const field of ['cash', 'debt', 'depreciation', 'capex']) if (finite(company.financials[field]) && company.financials[field] < 0) errors.push(error('INVALID_BOUND', `${field} 不能为负数。`, `company.financials.${field}`));
  if (finite(company.financials.taxRate) && (company.financials.taxRate < 0 || company.financials.taxRate > 1)) errors.push(error('INVALID_BOUND', '事实税率必须在 0 到 1 之间。', 'company.financials.taxRate'));
  if (!validDate(company.quoteDate)) errors.push(error('INVALID_DATE', '行情日期必须是有效的 YYYY-MM-DD 日期。', 'company.quoteDate'));
  if (!validDate(company.financials.reportDate)) errors.push(error('INVALID_DATE', '财报日期必须是有效的 YYYY-MM-DD 日期。', 'company.financials.reportDate'));
  if (!assumptions || !Array.isArray(assumptions.scenarios) || assumptions.scenarios.length !== 3) return [...errors, error('INVALID_SCENARIOS', 'Exactly bear, base, and bull scenarios are required.', 'assumptions.scenarios')];
  const names = assumptions.scenarios.map((s) => s?.name);
  if (new Set(names).size !== 3 || !['bear', 'base', 'bull'].every((n) => names.includes(n))) errors.push(error('INVALID_SCENARIOS', 'Scenario names must be bear, base, and bull.', 'assumptions.scenarios'));
  assumptions.scenarios.forEach((scenario, index) => {
    for (const field of SCENARIO_FIELDS) if (!finite(scenario?.[field])) errors.push(error('NONFINITE_VALUE', `${field} must be finite.`, `assumptions.scenarios.${index}.${field}`));
    if (!scenario) return;
    for (const field of ['revenuePath', 'marginPath']) {
      if (!Object.hasOwn(scenario, field)) continue;
      const values = scenario[field];
      const validEntry = (value) => finite(value) && (field === 'revenuePath' ? value > 0 : value >= -1 && value <= 1);
      if (!Array.isArray(values) || values.length !== 5 || !Array.from(values).every(validEntry)) errors.push(error('INVALID_PATH', `${field} must contain exactly five valid annual values.`, `assumptions.scenarios.${index}.${field}`));
    }
    const inRange = (field, min, max, includeMin = true) => {
      const value = scenario[field];
      if (finite(value) && ((includeMin ? value < min : value <= min) || value > max)) errors.push(error('INVALID_BOUND', `${field} is outside its valid range.`, `assumptions.scenarios.${index}.${field}`));
    };
    inRange('probability', 0, 1); inRange('growth', -0.99, 1); inRange('margin', -1, 1);
    inRange('taxRate', 0, 1); inRange('daRatio', 0, 2); inRange('capexRatio', 0, 2); inRange('nwcRatio', -2, 2);
    inRange('wacc', 0, 1, false); inRange('terminalGrowth', -0.99, 0.2); inRange('terminalRoic', -1, 2);
    if (finite(scenario.wacc) && finite(scenario.terminalGrowth) && scenario.wacc <= scenario.terminalGrowth) errors.push(error('WACC_NOT_ABOVE_GROWTH', 'WACC must exceed terminal growth.', `assumptions.scenarios.${index}`));
    if (finite(scenario.terminalGrowth) && finite(scenario.terminalRoic) && Math.abs(scenario.terminalGrowth) > EPS && scenario.terminalRoic <= 0) errors.push(error('TERMINAL_REINVESTMENT', 'Non-zero terminal growth requires positive terminal ROIC.', `assumptions.scenarios.${index}.terminalRoic`));
    if (finite(scenario.terminalGrowth) && finite(scenario.terminalRoic) && scenario.terminalGrowth > 0 && scenario.terminalRoic <= scenario.terminalGrowth) errors.push(error('TERMINAL_REINVESTMENT', 'Terminal ROIC must exceed positive terminal growth.', `assumptions.scenarios.${index}.terminalRoic`));
  });
  const probability = assumptions.scenarios.reduce((sum, s) => sum + (finite(s?.probability) ? s.probability : 0), 0);
  if (Math.abs(probability - 1) > 1e-8) errors.push(error('PROBABILITY_TOTAL', 'Scenario probabilities must total 1.', 'assumptions.scenarios'));
  if (!Number.isInteger(assumptions.advantageYears) || assumptions.advantageYears < 0 || assumptions.advantageYears > 100) errors.push(error('INVALID_BOUND', 'advantageYears must be an integer from 0 to 100.', 'assumptions.advantageYears'));
  if (!finite(assumptions.sustainedGrowth) || assumptions.sustainedGrowth <= -1 || assumptions.sustainedGrowth > 0.2) errors.push(error('INVALID_BOUND', 'sustainedGrowth must be greater than -1 and at most 0.2.', 'assumptions.sustainedGrowth'));
  return errors;
}

function project(financials, scenario, years = 5) {
  let revenue = financials.revenue;
  let previousNwc = financials.workingCapital;
  let pvExplicit = 0;
  const forecast = [];
  for (let year = 1; year <= years; year += 1) {
    revenue = scenario.revenuePath ? scenario.revenuePath[year - 1] : revenue * (1 + scenario.growth);
    const ebit = revenue * (scenario.marginPath ? scenario.marginPath[year - 1] : scenario.margin);
    const nopat = ebit * (1 - scenario.taxRate);
    const depreciation = revenue * scenario.daRatio;
    const capex = revenue * scenario.capexRatio;
    const projectedNwc = revenue * scenario.nwcRatio;
    const deltaNwc = projectedNwc - previousNwc;
    const fcff = nopat + depreciation - capex - deltaNwc;
    const pv = fcff / (1 + scenario.wacc) ** year;
    forecast.push({ year, revenue, ebit, nopat, depreciation, capex, deltaNwc, fcff, pv });
    pvExplicit += pv;
    previousNwc = projectedNwc;
  }
  return { revenue, projectedNwc: previousNwc, pvExplicit, forecast };
}

function scenarioValue(financials, scenario) {
  const projection = project(financials, scenario);
  const g = scenario.terminalGrowth;
  const reinvestmentRate = Math.abs(g) <= EPS ? 0 : g / scenario.terminalRoic;
  const terminalMargin = scenario.marginPath ? scenario.marginPath[4] : scenario.margin;
  const terminalFcff = projection.revenue * (1 + g) * terminalMargin * (1 - scenario.taxRate) * (1 - reinvestmentRate);
  const terminalValue = terminalFcff / (scenario.wacc - g);
  const pvTerminal = terminalValue / (1 + scenario.wacc) ** 5;
  const enterpriseValue = projection.pvExplicit + pvTerminal;
  const equityValue = enterpriseValue + financials.cash - financials.debt - financials.minorityInterest;
  return {
    name: scenario.name, valuePerShare: equityValue / financials.shares, enterpriseValue, equityValue,
    pvExplicit: projection.pvExplicit, pvTerminal, terminalShare: enterpriseValue === 0 ? null : pvTerminal / enterpriseValue,
    terminalFcff, forecast: projection.forecast,
  };
}

function sensitivity(financials, base) {
  const waccs = [-0.02, -0.01, 0, 0.01, 0.02].map((d) => base.wacc + d).filter((r) => r > 0);
  const growthRates = [-0.01, -0.005, 0, 0.005, 0.01].map((d) => base.terminalGrowth + d);
  const values = waccs.map((wacc) => growthRates.map((terminalGrowth) => {
    if (wacc <= terminalGrowth || (Math.abs(terminalGrowth) > EPS && base.terminalRoic <= 0) || (terminalGrowth > 0 && base.terminalRoic <= terminalGrowth)) return null;
    return scenarioValue(financials, { ...base, wacc, terminalGrowth }).valuePerShare;
  }));
  return { waccs, growthRates, values };
}

function bisect(fn, low, high, tolerance = 1e-9) {
  let lo = low; let hi = high; let flo = fn(lo); let fhi = fn(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo === 0) return flo === 0 ? low : null;
  if (fhi === 0) return high;
  if (Math.sign(flo) === Math.sign(fhi)) return null;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2; const fm = fn(mid);
    if (Math.abs(fm) < tolerance) return mid;
    if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

function durationValue(financials, scenario, sustainedGrowth, years) {
  if (years < 5) return NaN;
  const initial = project(financials, scenario, 5);
  const terminalMargin = scenario.marginPath ? scenario.marginPath[4] : scenario.margin;
  let revenue = initial.revenue; let previousNwc = initial.projectedNwc; let pvExplicit = initial.pvExplicit;
  for (let year = 6; year <= years; year += 1) {
    revenue *= 1 + sustainedGrowth;
    const projectedNwc = revenue * scenario.nwcRatio;
    const fcff = revenue * terminalMargin * (1 - scenario.taxRate) + revenue * scenario.daRatio - revenue * scenario.capexRatio - (projectedNwc - previousNwc);
    pvExplicit += fcff / (1 + scenario.wacc) ** year;
    previousNwc = projectedNwc;
  }
  const g = scenario.terminalGrowth;
  const reinvestmentRate = Math.abs(g) <= EPS ? 0 : g / scenario.terminalRoic;
  const terminalFcff = revenue * (1 + g) * terminalMargin * (1 - scenario.taxRate) * (1 - reinvestmentRate);
  const ev = pvExplicit + terminalFcff / (scenario.wacc - g) / (1 + scenario.wacc) ** years;
  return (ev + financials.cash - financials.debt - financials.minorityInterest) / financials.shares;
}

function reverse(financials, base, marketPrice, advantageYears, sustainedGrowth) {
  const target = finite(marketPrice) && marketPrice >= 0 ? marketPrice : null;
  if (target === null) return { impliedTerminalGrowth: null, impliedDurationYears: null, status: 'UNAVAILABLE', terminalGrowth: { status: 'UNAVAILABLE' }, duration: { status: 'UNAVAILABLE' } };
  let roots = [];
  let growthBounds;
  if (base.terminalRoic <= 0) {
    growthBounds = [0, 0];
    const difference = scenarioValue(financials, { ...base, terminalGrowth: 0 }).valuePerShare - target;
    if (Math.abs(difference) < 1e-7) roots = [0];
  } else {
    const lowerGrowth = -0.99;
    const upperGrowth = Math.min(base.wacc - 1e-6, base.terminalRoic - 1e-6, 0.2);
    growthBounds = [lowerGrowth, upperGrowth];
    if (upperGrowth > lowerGrowth) {
      const fn = (g) => scenarioValue(financials, { ...base, terminalGrowth: g }).valuePerShare - target;
      const points = [lowerGrowth];
      if (base.terminalRoic < base.wacc) {
        const stationary = base.wacc - Math.sqrt((1 + base.wacc) * (base.wacc - base.terminalRoic));
        if (stationary > lowerGrowth && stationary < upperGrowth) points.push(stationary);
      }
      points.push(upperGrowth);
      for (const point of points) if (Math.abs(fn(point)) < 1e-7) roots.push(point);
      for (let index = 0; index < points.length - 1; index += 1) {
        const root = bisect(fn, points[index], points[index + 1]);
        if (root !== null) roots.push(root);
      }
      roots = roots.sort((a, b) => a - b).filter((root, index, values) => index === 0 || Math.abs(root - values[index - 1]) > 1e-7);
    }
  }
  const growth = roots.length === 1 ? roots[0] : null;
  const growthResult = roots.length === 0
    ? { status: 'UNREACHABLE', bounds: growthBounds, roots: [] }
    : roots.length === 1
      ? { status: 'SOLVED', value: roots[0], bounds: growthBounds, roots }
      : { status: 'AMBIGUOUS', bounds: growthBounds, roots };
  const maxYears = 100;
  let duration = null;
  let previousDifference = durationValue(financials, base, sustainedGrowth, 5) - target;
  if (Math.abs(previousDifference) < 1e-7) duration = 5;
  for (let years = 6; years <= maxYears && duration === null; years += 1) {
    const difference = durationValue(financials, base, sustainedGrowth, years) - target;
    if (Math.abs(difference) < 1e-7) duration = years;
    else if (Number.isFinite(difference) && Number.isFinite(previousDifference) && Math.sign(difference) !== Math.sign(previousDifference)) {
      const fraction = Math.abs(previousDifference) / (Math.abs(previousDifference) + Math.abs(difference));
      duration = years - 1 + fraction;
    }
    previousDifference = difference;
  }
  const durationResult = duration === null ? { status: 'UNREACHABLE', bounds: [5, maxYears], comparison: 'UNAVAILABLE' } : {
    status: 'SOLVED', value: duration, bounds: [5, maxYears],
    comparison: Math.abs(duration - advantageYears) < 1e-6 ? 'EQUAL_TO_ASSUMPTION' : duration > advantageYears ? 'ABOVE_ASSUMPTION' : 'BELOW_ASSUMPTION',
  };
  return { impliedTerminalGrowth: growth, impliedDurationYears: duration, status: growthResult.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : growth !== null || duration !== null ? 'SOLVED' : 'UNREACHABLE', terminalGrowth: growthResult, duration: durationResult };
}

function allNumbersFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(allNumbersFinite);
  return Object.values(value).every(allNumbersFinite);
}

function buildWarnings(company, assumptions, scenarios, reverseResult) {
  const warnings = [error('INDEPENDENT_REVIEW_REQUIRED', '缺少独立证据审核，结果仅供草稿复核。')];
  for (const scenario of scenarios) {
    if (scenario.terminalShare !== null && scenario.terminalShare > 0.75) warnings.push(error('TERMINAL_VALUE_CONCENTRATION', `${scenario.name} 情景终值占比超过 75%。`, `scenarios.${scenario.name}.terminalShare`));
    if (scenario.forecast.some((year) => year.fcff < 0)) warnings.push(error('NEGATIVE_EXPLICIT_FCFF', `${scenario.name} 情景明确预测期存在负 FCFF。`, `scenarios.${scenario.name}.forecast`));
  }
  const historicalRoic = company.historical?.roic;
  if (finite(historicalRoic)) {
    for (const scenario of assumptions.scenarios) if (historicalRoic < scenario.wacc) warnings.push(error('HISTORICAL_ROIC_BELOW_WACC', `历史 ROIC 低于 ${scenario.name} 情景 WACC。`, 'company.historical.roic'));
  }
  if (reverseResult.duration.comparison === 'ABOVE_ASSUMPTION') warnings.push(error('GROWTH_DURATION_ABOVE_ASSUMPTION', '市场隐含增长持续期高于设定的竞争优势期。', 'reverse.duration'));
  if (reverseResult.terminalGrowth.status === 'AMBIGUOUS') warnings.push(error('AMBIGUOUS_TERMINAL_GROWTH', '市场价格对应多个有效的隐含永续增长率，不应展示单一解。', 'reverse.terminalGrowth'));
  return warnings;
}

export function evaluate(company, assumptions) {
  const errors = validate(company, assumptions);
  if (errors.length) return { status: 'BLOCKED', errors };
  const terminalErrors = [];
  const scenarios = assumptions.scenarios.map((scenario) => {
    const result = scenarioValue(company.financials, scenario);
    if (!(result.terminalFcff >= 0)) terminalErrors.push(error('NEGATIVE_TERMINAL_FCFF', `${scenario.name} terminal FCFF must not be negative.`, `assumptions.scenarios.${scenario.name}`));
    return result;
  });
  if (terminalErrors.length) return { status: 'BLOCKED', errors: terminalErrors };
  const base = assumptions.scenarios.find((scenario) => scenario.name === 'base');
  if (!allNumbersFinite(scenarios)) return { status: 'BLOCKED', errors: [error('NUMERIC_OVERFLOW', '计算结果超出有限数值范围，请检查输入量级。')] };
  const sensitivityResult = sensitivity(company.financials, base);
  const reverseResult = reverse(company.financials, base, company.price, assumptions.advantageYears, assumptions.sustainedGrowth);
  const result = {
    status: 'DRAFT_REVIEW', errors: [], scenarios,
    weightedValue: scenarios.reduce((sum, result) => sum + result.valuePerShare * assumptions.scenarios.find((s) => s.name === result.name).probability, 0),
    sensitivity: sensitivityResult,
    reverse: reverseResult,
    warnings: buildWarnings(company, assumptions, scenarios, reverseResult),
  };
  if (!allNumbersFinite(result)) return { status: 'BLOCKED', errors: [error('NUMERIC_OVERFLOW', '计算结果超出有限数值范围，请检查输入量级。')] };
  return result;
}
