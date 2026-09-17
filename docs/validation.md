# Release validation — 2026-09-17

- Node valuation suite: 19 passing tests, including an independent constant-FCFF identity, bridge checks, probability/rate bounds, first-year working-capital reconciliation, finite outputs, duration inversion, and ambiguous perpetual-growth roots.
- Python data suite: 11 passing tests covering missing-vs-zero, future disclosures, source failures, stale snapshots, method routing and quote-only share-count refresh.
- Independent solver review exercised 82 additional forward/inverse combinations; no remaining important software defect was found. Financial evidence review remains incomplete, so model output remains DRAFT_REVIEW.
- Browser: company-name and code search, whitespace-insensitive names, no-result clearing, bank-method exclusion, proposal opt-in, invalid WACC clearing prior output, recomputation and forecast table checked.
- Responsive: 390-pixel mobile viewport checked; no horizontal page overflow.
- Public URL returned HTTP 200 for index, JavaScript module (correct JavaScript MIME type) and dated data.
- GitHub Actions initial publication succeeded. Manual hosted refresh succeeded and collected 5,581 fresh quote records without provider errors, then persisted the snapshot and redeployed it.

## Practical limitations

The annual financial snapshot is a simplified model basis. Interim reporting, full working-capital schedules, diluted capital structure, restricted cash, post-report corporate actions and primary-disclosure verification require further research. Automatic industry routing is a coarse method guard, not a growth-quality classification. Price assumptions are research inputs, not forecasts or trade recommendations. Successful publication does not guarantee uninterrupted third-party data access; inspect the displayed source dates.
