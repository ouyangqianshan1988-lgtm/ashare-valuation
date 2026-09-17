# Valuation engine contract

Import the browser-native ES module with `import { evaluate } from './valuation.mjs'` and call `evaluate(company, assumptions)`. It is pure and does no I/O.

All monetary amounts are CNY, `shares` is the raw share count, and every rate is a decimal (`0.123` means 12.3%). Explicit zero is valid; omitted, `null`, empty, or non-finite required values are not converted to zero.

## Input

```js
company = {
  code: string,
  name: string,
  method: 'fcff' | 'financial' | 'cyclical' | 'nav' | 'unknown',
  price: number,
  quoteDate: string,
  historical?: {
    roic?: number // decimal; when supplied it is used for a quality warning
  },
  financials: {
    revenue: number,
    ebit: number,
    taxRate: number,
    depreciation: number,
    capex: number,
    workingCapital: number, // may be negative
    cash: number,
    debt: number,
    minorityInterest: number,
    shares: number,
    reportDate: string
  }
}

assumptions = {
  scenarios: [{
    name: 'bear' | 'base' | 'bull',
    probability: number,
    growth: number,
    margin: number,
    revenuePath?: number[], // exactly five positive absolute CNY revenues
    marginPath?: number[], // exactly five decimal EBIT margins in [-1, 1]
    taxRate: number,
    daRatio: number,
    capexRatio: number,
    nwcRatio: number,
    wacc: number,
    terminalGrowth: number,
    terminalRoic: number
  }], // exactly one of each name; probabilities total 1
  advantageYears: number, // integer, 0..100
  sustainedGrowth: number
}
```

Only `method: 'fcff'` is structurally suitable. Other methods return `BLOCKED`. The engine never calculates PEG. A caller must not convert collector percentages or fill absent facts implicitly inside the engine.

Annual paths are independently optional. When supplied, each must be an array of exactly five finite numeric entries; sparse arrays, explicit `undefined`, `null`, strings and invalid bounds return `BLOCKED` with `INVALID_PATH`. Each revenue must be positive; each margin must be between -1 and 1 inclusive. `growth` and `margin` remain required valid scalar inputs for compatibility, but the corresponding path overrides them in the five-year projection. Absolute revenue paths can represent first-year increases above 100%; the scalar growth bound remains -99% to 100%. Inputs, including path arrays, are never mutated.

## Output

Invalid input returns:

```js
{
  status: 'BLOCKED',
  errors: [{ code: string, message: string, path?: string }]
}
```

Valid input always returns `DRAFT_REVIEW`, never `PASS`:

```js
{
  status: 'DRAFT_REVIEW',
  errors: [],
  warnings: [{ code: string, message: string, path?: string }],
  scenarios: [{
    name: 'bear' | 'base' | 'bull',
    valuePerShare: number,
    enterpriseValue: number,
    equityValue: number,
    pvExplicit: number,
    pvTerminal: number,
    terminalShare: number | null,
    terminalFcff: number,
    forecast: [{
      year: 1 | 2 | 3 | 4 | 5,
      revenue: number,
      ebit: number,
      nopat: number,
      depreciation: number,
      capex: number,
      deltaNwc: number,
      fcff: number,
      pv: number
    }]
  }],
  weightedValue: number,
  sensitivity: {
    waccs: number[],
    growthRates: number[],
    values: (number | null)[][] // rows match waccs, columns match growthRates
  },
  reverse: {
    impliedTerminalGrowth: number | null,
    impliedDurationYears: number | null,
    status: 'SOLVED' | 'AMBIGUOUS' | 'UNREACHABLE' | 'UNAVAILABLE',
    terminalGrowth: {
      status: 'SOLVED' | 'AMBIGUOUS' | 'UNREACHABLE' | 'UNAVAILABLE',
      value?: number,
      bounds?: [number, number],
      roots?: number[]
    },
    duration: {
      status: 'SOLVED' | 'UNREACHABLE' | 'UNAVAILABLE',
      value?: number,
      bounds?: [number, number],
      comparison?: 'ABOVE_ASSUMPTION' | 'BELOW_ASSUMPTION' | 'EQUAL_TO_ASSUMPTION' | 'UNAVAILABLE'
    }
  }
}
```

## Calculation rules

Five explicit years use the supplied annual revenue and margin entries, or uniform revenue growth and margin when their respective paths are absent, and `FCFF = EBIT × (1-tax) + D&A - capex - deltaNWC`. Terminal FCFF is `year5 revenue × (1+g) × year5 margin × (1-tax) × (1-g/ROIC)`. The fifth margin path entry also applies throughout duration extensions after year five. Sensitivity and reverse calculations preserve both paths. Calendar labels are the caller's responsibility: forecast years 1–5 correspond to the year of `financials.reportDate` plus 1–5. Zero growth has zero reinvestment even when terminal ROIC is zero. Enterprise value is explicit PV plus terminal PV; equity value adds cash and subtracts debt and minority interest, then divides by shares.

Year-one projected NWC is `year1 revenue × nwcRatio`; its cash-flow change is measured from reported `financials.workingCapital`. Later changes are measured from the prior projected NWC.

Reverse terminal growth uses the base case and a bounded valid region below WACC and, for positive growth, below terminal ROIC. When positive terminal ROIC is below WACC, the valuation curve may be non-monotonic; the solver splits the domain at its stationary point and reports every distinct root. Multiple roots return `AMBIGUOUS`, put all candidates in `terminalGrowth.roots`, and leave `impliedTerminalGrowth` null. With non-positive terminal ROIC, only zero terminal growth is admissible: it returns `SOLVED` only when the zero-growth forward value matches the target. Reverse duration always preserves the initial five-year base forecast. It then extends final-year economics from total year 6 through year 100 using finite `sustainedGrowth`; the terminal calculation uses the base scenario's `terminalGrowth` and `terminalRoic`. Consequently `sustainedGrowth` may exceed WACC. Values below five forecast years are outside the solve region. Adjacent integer-year results are linearly interpolated when they straddle the market value. Unreachable targets are explicit.

All returned numeric values are checked for finiteness. Overflow returns `BLOCKED` with `NUMERIC_OVERFLOW`. Cash, debt, depreciation, and capex must be non-negative; factual tax rate must be from 0 to 1; quote and report dates must be real `YYYY-MM-DD` dates. Minority interest and working capital may be negative.

Warnings do not change `DRAFT_REVIEW`. Current warning codes are `INDEPENDENT_REVIEW_REQUIRED`, `TERMINAL_VALUE_CONCENTRATION`, `HISTORICAL_ROIC_BELOW_WACC`, `NEGATIVE_EXPLICIT_FCFF`, `GROWTH_DURATION_ABOVE_ASSUMPTION`, and `AMBIGUOUS_TERMINAL_GROWTH`.
