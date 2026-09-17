# Forecast correction verification — 2026-09-17

Root cause: initial uniform revenue growth was unrelated to company forecasts; historical effective tax, working capital and other ratios were carried forward without a review gate. This correction replaces revenue defaults with dated annual company data where available and withholds prices pending assumption review. It does not claim a complete company-specific cost-of-capital model or today's fair value.

Live source validation: Eastmoney `RPT_WEB_RESPREDICT` coverage and `ProfitForecast/PageAjax` returned 2,897 companies with estimate rows across 5,581 retained market records, zero collection errors. 2,052 records qualified for annual paths after report-date, indicator-count, calendar alignment and finance-expense checks (method routing is a separate valuation gate). 239 estimated records lacked an individual research-report date and were not adopted automatically.

Source spot checks (2026 forecast, CNY):
- 688256: revenue 16,255,666,000 (15 institutions), operating profit 5,934,733,333.33 (15), EPS 9.79625 (16); newest returned individual report 2026-09-02.
- 600519: revenue 177,544,082,173.913 (46), operating profit 117,650,948,604.651 (43), EPS 67.65673913 (46); newest returned individual report 2026-08-28.

Tests: parser E/A distinction, units, null preservation, wrong-company and invalid/future-date rejection, incomplete coverage, cache timestamp preservation and removed coverage. Model tests cover annual cash-flow PV, fifth-year terminal margin, reverse and sensitivity consistency, >100% sourced first-year revenue jumps, malformed paths and loss-to-profit scenario direction. Legacy tests retained.

Browser verification on localhost:
- 688256 forecast table and first revenue input match source; abnormal historical tax is blank. Selecting known partial debt and accepting assumptions still blocks until forecast tax is provided.
- Explicit test tax input permits conditional calculation; changing annual revenue clears price and acknowledgement immediately.
- Reset restores source; stock selection persists through a section anchor and page reload.
- 600519 shows its own forecast and institutional counts; an unavailable-forecast company shows empty growth/margin and no price.
- Mobile 390px and desktop tested; source table scrolls within its container, no page-width overflow. Temporary viewport override reset.

Independent review found signed margin stress reversed bear/bull meaning for negative margins; fixed with margin +/- 10% of its absolute value and a red/green regression test. Forecast cash-flow table now uses calendar years.

Remaining limitations: aggregate fields have different institution sets and dates; newest visible research date is not a field-level update timestamp. Operating profit is converted to an EBIT proxy using historical finance-expense/revenue. Years outside source coverage, WACC, tax, capital investment, terminal economics and scenario stress remain explicit hypotheses. Annual financial baseline is not rolled forward to the current date; prices are conditional baseline estimates rather than current fair-value assertions.
