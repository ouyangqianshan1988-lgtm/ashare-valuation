import {evaluate} from './valuation.mjs?v=20260917-forecast2';
import {initialAssumptions,forecastContext} from './forecast-model.mjs?v=20260917-forecast';

export const policyVersion='2026-09-18-auto1';
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const positive=n=>finite(n)&&n>0;
const engineCompany=c=>({...c,historical:{...c.historical,roic:finite(c.historical?.roic)?c.historical.roic/100:null}});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const quantile=(a,p)=>{if(!a.length)return null;const k=(a.length-1)*p,l=Math.floor(k);return a[l]+(a[Math.ceil(k)]-a[l])*(k-l);};
const bounds={debt:[0,3],depreciation:[0,.3],capex:[0,.4],workingCapital:[-.3,1],cash:[0,2],margin:[-.5,.6],growth:[-.1,.3],tax:[.1,.35],roic:[.04,.3],PE:[2,80],PB:[.2,10],PS:[.2,20]};
function metrics(c){const f=c.financials||{},r=f.revenue,h=c.historical||{};const m={PE:c.pe,PB:c.pb,PS:positive(r)&&positive(c.marketCap)?c.marketCap/r:null,growth:finite(h.revenueGrowth)?h.revenueGrowth/100:null,roic:finite(h.roic)?h.roic/100:null,tax:f.taxRate};for(const k of ['debt','depreciation','capex','workingCapital','cash'])m[k]=positive(r)&&finite(f[k])?f[k]/r:null;m.margin=positive(r)&&finite(f.ebit)?f.ebit/r:null;return m;}
function add(group,c){const m=metrics(c);for(const [k,[lo,hi]]of Object.entries(bounds)){const v=m[k];if(finite(v)&&v>=lo&&v<=hi)(group[k]??=[]).push({code:c.code,value:v});}}
export function buildPeerIndex(companies){const index={industry:new Map(),route:new Map(),all:{}};for(const c of Array.isArray(companies)?companies:Object.values(companies||{})){if(!index.industry.has(c.industry))index.industry.set(c.industry,{});if(!index.route.has(c.method))index.route.set(c.method,{});add(index.industry.get(c.industry),c);add(index.route.get(c.method),c);add(index.all,c);}for(const g of [...index.industry.values(),...index.route.values(),index.all])for(const rows of Object.values(g))rows.sort((a,b)=>a.value-b.value);return index;}
function sample(index,c,key){let last={values:[],scope:'全市场'};for(const [group,scope]of [[index?.industry?.get(c.industry),'同行业'],[index?.route?.get(c.method),'同估值类别'],[index?.all,'全市场']]){const values=(group?.[key]||[]).filter(x=>x.code!==c.code).map(x=>x.value);last={values,scope};if(values.length>=5)return last;}return last;}
const median=(p,c,k,fallback)=>quantile(sample(p,c,k).values,.5)??fallback;
function relative(c,p){const f=c.financials||{},preferred=['financial','nav','cyclical'].includes(c.method)?['PB','PE','PS']:['PE','PS','PB'];for(const metric of preferred){const unitValue=metric==='PB'&&positive(c.pb)&&positive(c.price)?c.price/c.pb:metric==='PE'&&positive(c.pe)&&positive(c.price)?c.price/c.pe:metric==='PS'&&positive(f.revenue)&&positive(f.shares)?f.revenue/f.shares:null;if(!positive(unitValue))continue;const {values,scope}=sample(p,c,metric);if(values.length)return {metric,unitValue,multiples:[.25,.5,.75].map(q=>quantile(values,q)),peerCount:values.length,scope};}return null;}
export function buildAutomaticEstimate(company,forecast,peers,now=new Date()){
  const c={...company,financials:{...(company.financials||{})}},f=c.financials,notes=[],fieldSources={},financialOverrides={};
  const set=(key,value,source)=>{if(!finite(f[key])&&finite(value)){financialOverrides[key]=value;f[key]=value;fieldSources[key]=source;}};
  for(const [key,value]of Object.entries(f))if(value!=null)fieldSources[key]='来源数据：原始财报/行情字段';
  if(positive(c.marketCap)&&positive(c.price))set('shares',c.marketCap/c.price,'系统推算：行情市值÷现价，非已核实摊薄股本');
  if(positive(f.revenue)){
    for(const [key,defaultRatio]of Object.entries({debt:.25,depreciation:.04,capex:.06,workingCapital:.15,cash:.15})){
      const proposal=c.proposals?.[key]?.value;
      if(['debt','depreciation'].includes(key)&&finite(proposal)&&proposal>=0)set(key,proposal,'系统估计：采用已披露项目小计；未披露部分暂按零，可能低估');
      set(key,f.revenue*median(peers,c,key,defaultRatio),'系统估计：同行业/同类别/全市场中位比例；无样本用规则比例');
    }
  }
  set('minorityInterest',0,'系统估计：未披露少数股东权益暂按零');
  const ctx=forecastContext(c,forecast,now),assumptions=initialAssumptions(c,forecast,now);
  const tax=finite(f.taxRate)&&f.taxRate>=.1&&f.taxRate<=.35?f.taxRate:median(peers,c,'tax',.25);
  const historicalMargin=positive(f.revenue)&&finite(f.ebit)?f.ebit/f.revenue:null;
  const peerMargin=median(peers,c,'margin',historicalMargin??.08);
  const growth=clamp(finite(c.historical?.revenueGrowth)?.6*clamp(c.historical.revenueGrowth/100,-.1,.3)+.4*median(peers,c,'growth',.02):median(peers,c,'growth',.02),-.1,.3);
  const margin=clamp(historicalMargin??peerMargin,-.5,.6);
  const terminalMargin=margin<=0?margin:clamp(.6*margin+.4*peerMargin,.005,.6);
  const leverage=positive(f.revenue)&&finite(f.debt)?f.debt/f.revenue:.25;
  const wacc=clamp(.085+(positive(c.marketCap)&&c.marketCap<2e10?.015:0)+Math.min(.02,Math.max(0,leverage)*.01)+(/半导体|软件|生物|计算机/.test(c.industry||'')?.01:0),.07,.14);
  const historicalRoic=finite(c.historical?.roic)?c.historical.roic/100:null;
  const roic=clamp(positive(historicalRoic)?historicalRoic:median(peers,c,'roic',.1),.05,.25);
  fieldSources.forecastTaxRate=tax===f.taxRate?'前瞻假设：延用10%–35%内的历史有效税率':'系统假设：有效同行税率中位数；无样本按25%';
  fieldSources.wacc='系统假设：8.5%基准＋小市值1.5个百分点＋杠杆0–2个百分点＋科技行业1个百分点，限制7%–14%';
  fieldSources.terminalRoic='系统假设：历史ROIC（百分数转比例）或同业中位数，限制5%–25%';
  fieldSources.revenuePath=ctx.usable?'来源预测：机构营收汇总；未覆盖年度为系统收敛假设':'系统预测：自身历史增速60%＋同业40%，限制−10%–30%，五年收敛至2%';
  fieldSources.marginPath=ctx.usable?'来源预测：机构营业利润＋历史财务费用比例；压力幅度为系统假设':'系统预测：历史利润率逐步靠近同业中位数；亏损不假设自动扭亏';
  assumptions.scenarios.forEach((s,i)=>{
    Object.assign(s,{taxRate:tax,wacc:clamp(wacc+[.015,0,-.015][i],.07,.14),terminalRoic:roic,growth,margin:terminalMargin});
    for(const [key,field,defaultRatio]of [['daRatio','depreciation',.04],['capexRatio','capex',.06],['nwcRatio','workingCapital',.15]]){
      s[key]=clamp(positive(f.revenue)&&finite(f[field])?f[field]/f.revenue:median(peers,c,field,defaultRatio),...bounds[field]);
      fieldSources[key]='前瞻假设：历史或估计比例，并限制在政策范围；原始财报数值保持不变';
    }
    if(!ctx.usable){let revenue=positive(f.revenue)?f.revenue:1;s.revenuePath=Array.from({length:5},(_,y)=>{revenue*=1+clamp(growth+[ -.03,0,.03][i],-.1,.3)*(1-(y+1)/5)+.02*(y+1)/5;return revenue;});s.marginPath=Array.from({length:5},(_,y)=>clamp((margin+(terminalMargin-margin)*(y+1)/5)+Math.abs(margin+(terminalMargin-margin)*(y+1)/5)*[-.1,0,.1][i],-1,1));}
    s.margin=s.marginPath[4];
  });
  assumptions.forecastYears=ctx.usable?ctx.years.length:0;
  assumptions.forecastReason=ctx.usable?ctx.reason:'机构预测不可用或已过期；自动采用历史与同业假设。';
  const estimate={method:'fcff',financialOverrides,assumptions,notes,confidence:ctx.usable&&Object.keys(financialOverrides).length===0?'中':'低',forecastYears:assumptions.forecastYears,fieldSources,policyVersion};
  notes.push(ctx.usable?'采用可用机构预测；情景权重为模型配置，不代表发生概率。':'自动预测依据历史与同业，非机构一致预期；可信度低。');
  if(!ctx.usable&&forecast)notes.push('机构预测未通过日期或覆盖检查，未用于预测路径。');
  if(Object.keys(financialOverrides).length)notes.push('缺失财务字段已由系统估计；详情列示来源与规则。');
  if(margin<=0&&!ctx.usable)notes.push('历史亏损，未假定自动扭亏，优先采用相对估值。');
  const result=c.method==='fcff'&&positive(f.revenue)?evaluate(engineCompany(c),assumptions):null;
  if(!result||result.status!=='DRAFT_REVIEW'||result.scenarios.some(s=>s.valuePerShare<=0||s.terminalFcff<=0)){
    estimate.relative=relative(c,peers);
    estimate.method=estimate.relative?'relative':'unavailable';estimate.confidence='低';
    if(estimate.relative){notes.length=0;notes.push('机构预测仅供参考，本次采用同行相对估值。');estimate.forecastYears=0;const r=estimate.relative;notes.push(`采用${r.scope}${r.peerCount}家公司${r.metric}分位数相对估值，非现金流内在价值。`);fieldSources.relative=r.metric==='PS'?'来源单位值：财报营收÷股数；系统假设：可比公司倍数分位数':'来源单位值：现价÷行情报告的PE/PB，口径随行情比率；系统假设：可比公司倍数分位数';if(r.scope!=='同行业'||r.peerCount<5)notes.push('同行样本不足，扩大比较范围或使用少量样本；可信度低。');}
    else notes.push('缺少支持现金流或相对估值的必要数据，暂无法生成数值。');
  }
  return estimate;
}
export function evaluateAutomatic(company,estimate,assumptions=estimate.assumptions){
  if(estimate.method==='fcff')return evaluate(engineCompany({...company,financials:{...company.financials,...estimate.financialOverrides}}),assumptions);
  if(estimate.method==='relative'&&estimate.relative){const r=estimate.relative,scenarios=['bear','base','bull'].map((name,i)=>({name,valuePerShare:r.unitValue*r.multiples[i]}));if(scenarios.every(s=>positive(s.valuePerShare)))return {status:'DRAFT_REVIEW',errors:[],warnings:[],scenarios,weightedValue:scenarios.reduce((sum,s)=>sum+s.valuePerShare*(assumptions.scenarios.find(x=>x.name===s.name)?.probability??0),0)};}
  return {status:'BLOCKED',errors:[{code:'INSUFFICIENT_AUTOMATIC_DATA',message:'数据不足，暂无法自动估值。'}]};
}
