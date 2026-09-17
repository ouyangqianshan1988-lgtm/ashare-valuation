const finite=n=>typeof n==='number'&&Number.isFinite(n);
const day=86400000;

export function forecastContext(company, forecast, now=new Date()) {
  const unavailable=reason=>({usable:false,reason,years:[]});
  if(!forecast||forecast.code!==company.code) return unavailable('暂未取得该公司的机构预测，请手动提供预测依据。');
  if(!['ok','error_cached'].includes(forecast.status)) return unavailable('该公司的机构预测暂不可用。');
  const collected=Date.parse(forecast.collectedAt), published=Date.parse(forecast.latestReportDate);
  if(!finite(collected)||now-collected>7*day||collected-now>day) return unavailable('预测快照已超过 7 天或采集日期异常，暂不自动用于估值。');
  if(!finite(published)||now-published>180*day||published-now>day) return unavailable('缺少近 180 天的机构研报日期，暂不自动用于估值。');
  const f=company.financials,first=Number(f.reportDate?.slice(0,4))+1;
  if(!finite(f.revenue)||f.revenue<=0||!finite(company.historical?.financeExpense)) return unavailable('缺少同报告期营收或财务费用，不能把营业利润预测转换为 EBIT 近似值。');
  const years=(forecast.years||[]).filter(y=>y.kind==='estimate'&&y.year>=first&&y.year<first+3).sort((a,b)=>a.year-b.year);
  if(years.length<2||years.some((y,i)=>y.year!==first+i)) return unavailable('机构预测未覆盖从财报基期起连续至少两年，不能用统一增速补齐。');
  if(years.some(y=>!finite(y.revenue)||y.revenue<=0||!finite(y.operatingProfit)||y.counts?.revenue<2||y.counts?.operatingProfit<2||!finite(y.counts?.revenue)||!finite(y.counts?.operatingProfit))) return unavailable('营收或营业利润预测缺失，或对应指标预测机构少于 2 家。');
  const financeRatio=company.historical.financeExpense/f.revenue;
  if(years.some(y=>Math.abs(y.operatingProfit/y.revenue+financeRatio)>1)) return unavailable('预测利润率异常，需人工核对财报与预测口径。');
  return {usable:true,reason:'逐年采用东方财富机构预测汇总；营业利润按历史财务费用比例转换为 EBIT 近似值。',years,financeRatio};
}

export function initialAssumptions(company, forecast, now=new Date()) {
  const f=company.financials,ctx=forecastContext(company,forecast,now);
  const ratio=n=>finite(n)&&f.revenue>0?n/f.revenue:null;
  // Extreme effective rates are not silently projected indefinitely.
  const tax=finite(f.taxRate)&&f.taxRate>=.05&&f.taxRate<=.4?f.taxRate:null;
  return {advantageYears:10,sustainedGrowth:.07,forecastYears:ctx.years.length,forecastReason:ctx.reason,
    scenarios:['bear','base','bull'].map((name,i)=>{
      const s={name,probability:[.25,.5,.25][i],growth:null,margin:null,wacc:[.11,.095,.08][i],terminalGrowth:[.015,.02,.025][i],terminalRoic:.12,taxRate:tax,daRatio:ratio(f.depreciation),capexRatio:ratio(f.capex),nwcRatio:ratio(f.workingCapital)};
      if(ctx.usable){
        // Stress levels are model assumptions, not analyst low/high forecasts.
        const scale=[.9,1,1.1][i];
        s.revenuePath=ctx.years.map(y=>y.revenue*scale);
        s.marginPath=ctx.years.map(y=>{
          const margin=y.operatingProfit/y.revenue+ctx.financeRatio;
          return margin+[-.1,0,.1][i]*Math.abs(margin);
        });
        const count=ctx.years.length;
        const lastGrowth=ctx.years.at(-1).revenue/ctx.years.at(-2).revenue-1;
        for(let n=count;n<5;n++){
          const progress=(n-count+1)/(5-count);
          const growth=lastGrowth+(s.terminalGrowth-lastGrowth)*progress;
          s.revenuePath.push(s.revenuePath.at(-1)*(1+growth));
          s.marginPath.push(s.marginPath.at(-1));
        }
        s.growth=0; // unused for annual paths; never substitute EPS growth
        s.margin=s.marginPath[4];
      }
      return s;
    })};
}
