// Daily, deterministic automatic forecasts from the collected snapshots.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPeerIndex, buildAutomaticEstimate, evaluateAutomatic } from '../site/automatic-model.mjs';

const data=fileURLToPath(new URL('../site/data/',import.meta.url));
const market=JSON.parse(fs.readFileSync(data+'companies.json','utf8'));
let forecast={companies:{},meta:{}};
try { forecast=JSON.parse(fs.readFileSync(data+'forecasts.json','utf8')); } catch { /* history-based estimates remain available */ }
const peers=buildPeerIndex(market.companies), now=new Date();
const companies={}, coverage={fcff:0,relative:0,unavailable:0};
for(const [code,company] of Object.entries(market.companies)) {
  const estimate=buildAutomaticEstimate(company,forecast.companies[code],peers,now);
  const result=evaluateAutomatic(company,estimate);
  const values=(result.scenarios||[]).map(s=>s.valuePerShare);
  if(result.status!=='BLOCKED'&&(!Number.isFinite(result.weightedValue)||values.length!==3||!values.every(Number.isFinite))) throw new Error('Invalid automatic valuation: '+code);
  companies[code]={...estimate,inputs:{collectedAt:company.collectedAt,price:company.price,quoteDate:company.quoteDate,forecastCollectedAt:forecast.companies[code]?.collectedAt??null},summary:{status:result.status,weightedValue:result.weightedValue??null,values}};
  coverage[estimate.method]++;
}
const payload={meta:{generatedAt:now.toISOString(),financialCollectedAt:market.meta.collectedAt,forecastCollectedAt:forecast.meta.collectedAt??null,total:Object.keys(companies).length,coverage},companies};
const text=JSON.stringify(payload,(_,value)=>{if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Nonfinite estimate');return value;});
fs.writeFileSync(data+'estimates.tmp',text);fs.renameSync(data+'estimates.tmp',data+'estimates.json');
console.log(JSON.stringify(payload.meta));
