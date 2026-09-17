import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastContext, initialAssumptions } from '../site/forecast-model.mjs';
const now=new Date('2026-09-17T15:00:00Z');
const company={code:'688256',financials:{reportDate:'2025-12-31',revenue:100,ebit:20,taxRate:0.0004,depreciation:3,capex:4,workingCapital:10},historical:{financeExpense:1}};
const forecast={code:'688256',status:'ok',collectedAt:now.toISOString(),latestReportDate:'2026-08-01',years:[2026,2027,2028].map((year,i)=>({year,kind:'estimate',revenue:[250,400,500][i],operatingProfit:[50,100,150][i],eps:2+i,counts:{revenue:5,operatingProfit:4,eps:5}}))};
test('uses sourced absolute revenues, not EPS growth or uniform defaults',()=>{
 const a=initialAssumptions(company,forecast,now),base=a.scenarios[1];
 assert.deepEqual(base.revenuePath.slice(0,3),[250,400,500]);
 assert.ok(Math.abs(base.marginPath[0]-.21)<1e-12);
 assert.ok(base.revenuePath[3]>500);
 assert.ok(Math.abs(base.revenuePath[4]/base.revenuePath[3]-1-.02)<1e-10);
 assert.equal(base.taxRate,null,'abnormally low historic tax must require input');
 assert.equal(a.forecastYears,3);
});
test('missing, stale, wrong-code, sparse and insufficiently covered forecasts do not generate a price path',()=>{
 for(const f of [null,{...forecast,code:'600519'},{...forecast,collectedAt:'2026-08-01'}, {...forecast,latestReportDate:'2025-12-01'}, {...forecast,years:[forecast.years[0],forecast.years[2]]},{...forecast,years:forecast.years.map(y=>({...y,counts:{revenue:1,operatingProfit:1}}))}]){
  assert.equal(forecastContext(company,f,now).usable,false);
  const a=initialAssumptions(company,f,now);
  assert.equal(a.scenarios[1].growth,null);
  assert.equal(a.scenarios[1].margin,null);
  assert.equal(a.scenarios[1].revenuePath,undefined);
 }
});
test('actual years never masquerade as forecasts, and missing finance expense blocks EBIT proxy',()=>{
 assert.equal(forecastContext(company,{...forecast,years:forecast.years.map(y=>({...y,kind:'actual'}))},now).usable,false);
 assert.equal(forecastContext({...company,historical:{}},forecast,now).usable,false);
});
test('missing capital inputs remain missing; fresh source inputs are not mutated',()=>{
 const snapshot=JSON.stringify(forecast), c={...company,financials:{...company.financials,depreciation:null}};
 const a=initialAssumptions(c,forecast,now);
 assert.equal(a.scenarios[1].daRatio,null);
 a.scenarios[1].revenuePath[0]=999;
 assert.equal(JSON.stringify(forecast),snapshot);
});
test('bearish margin stress worsens losses instead of reversing the scenarios',()=>{
 const losing={...forecast,years:forecast.years.map((y,i)=>({...y,operatingProfit:i===0?-50:y.operatingProfit}))};
 const a=initialAssumptions(company,losing,now);
 assert.ok(a.scenarios[0].marginPath[0]<a.scenarios[1].marginPath[0]);
 assert.ok(a.scenarios[2].marginPath[0]>a.scenarios[1].marginPath[0]);
});
