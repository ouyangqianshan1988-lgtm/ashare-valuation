import { evaluate } from './valuation.mjs';
import { initialAssumptions, forecastContext } from './forecast-model.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite = n => typeof n === 'number' && Number.isFinite(n);
const fmt = (n, digits=2) => finite(n) ? n.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
const pct = n => finite(n) ? `${fmt(n*100,1)}%` : '—';
const labels = {bear:'悲观情景',base:'基准情景',bull:'乐观情景'};
const methods = {fcff:'FCFF 现金流折现',financial:'金融企业 · 专用模型',nav:'资产净值 / 分部估值',cyclical:'周期企业 · 盈利正常化',unknown:'方法待确认'};
const factLabels = {revenue:'年度营业收入',ebit:'EBIT 近似值',taxRate:'有效税率',depreciation:'年度折旧与摊销',capex:'年度资本支出',workingCapital:'经营营运资本（简化）',cash:'账面货币资金',debt:'有息债务合计',minorityInterest:'少数股东权益',shares:'总股本（未核实稀释）'};
const assumptionLabels = {probability:'情景概率',growth:'年营收增长率',margin:'EBIT 利润率',wacc:'折现率 WACC',terminalGrowth:'永续增长率',terminalRoic:'终值 ROIC',taxRate:'预测税率',daRatio:'折旧 / 营收',capexRatio:'资本支出 / 营收',nwcRatio:'营运资本 / 营收'};
const featured = ['600519','000333','300750','600900','600036','601318','600276','002594','000858','601088'];
let companies = {}, metadata = {}, forecasts = {}, forecastMetadata = {}, selected, assumptions, edits = {}, result = null;

function defaultAssumptions(c) {
  return initialAssumptions(c,forecasts[c.code]);
}
function listStocks(query='') {
  const q=query.trim().toLowerCase();
  const matches=q ? Object.values(companies).filter(c=>c.code.includes(q)||c.name.toLowerCase().replace(/\s/g,'').includes(q.replace(/\s/g,''))) : featured.map(code=>companies[code]).filter(Boolean);
  $('list-label').textContent=q ? `检索结果 · ${matches.length} 项` : '常用研究标的';
  $('stock-list').innerHTML=matches.length ? matches.slice(0,60).map(c=>`<button class="stock-button ${selected?.code===c.code?'selected':''}" data-code="${esc(c.code)}" aria-label="${esc(c.name)} ${c.code}"><span><b>${esc(c.name)}</b><small>${c.code} · ${c.code.startsWith('6')?'SH':c.code.startsWith('0')||c.code.startsWith('3')?'SZ':'BJ'}</small></span><span class="mini-price">${fmt(c.price)}<small class="${c.changePct>=0?'up':'down'}">${c.changePct>0?'+':''}${fmt(c.changePct)}%</small></span></button>`).join('') : '<p class="empty-state">未找到匹配股票。<br>试试六位代码或公司简称。</p>';
  if(q && !matches.length){$('company-view').hidden=true;result=null;}
  else if(selected) $('company-view').hidden=false;
}
function selectCompany(code) {
  selected=companies[code]; if(!selected)return;
  edits={};assumptions=defaultAssumptions(selected);result=null;
  $('company-view').hidden=false;
  const c=selected, age=(Date.now()-Date.parse(c.quoteDate+'T00:00:00+08:00'))/86400000;
  $('company-overview').innerHTML=`<div><p class="stock-kicker">A 股研究档案 / ${esc(c.industry||'行业待确认')}</p><h2 class="stock-name">${esc(c.name)}<span>${c.code}</span></h2><div class="stock-tags"><span>${esc(methods[c.method])}</span><span>年度财报 ${esc(c.financials.reportDate||'缺失')}</span></div></div><div><p class="quote-label">行情快照 · 元 / 股</p><div class="price"><small>¥</small>${fmt(c.price)}</div><span class="${c.changePct>=0?'up':'down'}">${c.changePct>0?'+':''}${fmt(c.changePct)}% <small>当日涨跌</small></span><p class="quote-date">${esc(c.quoteDate||'日期缺失')} ${esc(c.quoteTime||'')} · 腾讯财经</p>${age>4?'<p class="freshness">行情已超过 4 天，请留意数据时效</p>':''}</div><div class="overview-facts"><div><span>总市值</span><b>${fmt(c.marketCap/1e8,0)} <small>亿</small></b></div><div><span>市盈率（行情口径）</span><b>${fmt(c.pe)} <small>倍</small></b></div><div><span>市净率</span><b>${fmt(c.pb)} <small>倍</small></b></div></div>`;
  $('report-period').textContent=`基期 ${c.financials.reportDate||'待补充'}`;
  $('assumptions-reviewed').checked=false;
  renderConsensus();renderFacts();renderAssumptions();calculate();listStocks($('search').value);
  const url=new URL(location.href);url.searchParams.set('stock',code);url.hash=code;
  history.replaceState(null,'',url);
}
function renderFacts() {
  $('facts').innerHTML=`<div class="facts-grid">${Object.entries(factLabels).map(([key,label])=>{
    const n=Object.hasOwn(edits,key)?edits[key]:selected.financials[key], scale=key==='taxRate'?.01:1e8;
    return `<label class="fact-field"><span>${label}<small>${Object.hasOwn(edits,key)?'用户提供':finite(n)?'来源 / 计算':'数据缺失'} · ${key==='taxRate'?'%':key==='shares'?'亿股':'亿元'}</small></span><input type="number" step="any" data-fact="${key}" aria-label="${label}" value="${finite(n)?n/scale:''}" placeholder="请补充" class="${Object.hasOwn(edits,key)?'edited':!finite(n)?'missing':''}"></label>`;
  }).join('')}</div><div class="fact-note">${selected.notes.map(n=>esc(n)).join('<br>')}<br>财报公告日期：${esc(selected.noticeDate||'缺失')}。报告期与行情日不同，期间分红、回购、融资等尚未滚动调整。</div>`;
  $('sources').innerHTML=selected.sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}${s.date?' · '+esc(s.date):''} ↗</a>`).join('');
}
function assumptionSource(key, index) {
  const f=selected.financials, period=esc(f.reportDate||'报告期缺失');
  if(['growth','margin'].includes(key)) return '缺少可采用的逐年预测 · 请提供自己的预测';
  if(['probability','wacc','terminalGrowth','terminalRoic'].includes(key)) return '初始：通用假设 · 需自行判断';
  if(key==='taxRate') return finite(f.taxRate)&&f.taxRate>=.05&&f.taxRate<=.4 ? `初始：${period} 历史有效税率 · 需核对持续性` : '历史税率缺失或异常 · 请填写长期预测税率';
  const fact={margin:'ebit',daRatio:'depreciation',capexRatio:'capex',nwcRatio:'workingCapital'}[key];
  if(f.revenue>0&&finite(f[fact])) return `初始：${period} 财报计算${key==='margin'&&index!==1?' × '+(index===0?'90%':'110%')+' 假设':''} · 非未来预测`;
  return '缺少完整财报数据 · 请提供预测比例';
}
function renderConsensus() {
  const f=forecasts[selected.code], ctx=forecastContext(selected,f);
  const rows=(f?.years||[]).filter(y=>y.kind==='estimate').sort((a,b)=>a.year-b.year);
  $('consensus').innerHTML=`<p class="${ctx.usable?'muted':'freshness'}">${esc(ctx.reason)}</p>${rows.length?`<div class="table-scroll"><table><thead><tr><th>预测年度</th><th>营收 / 亿元（机构数）</th><th>营业利润 / 亿元（机构数）</th><th>每股收益 / 元（机构数）</th><th>现价 / 预测 EPS</th></tr></thead><tbody>${rows.map(y=>`<tr><th>${y.year}E</th><td>${fmt(finite(y.revenue)?y.revenue/1e8:null)}（${esc(y.counts?.revenue??'—')}）</td><td>${fmt(finite(y.operatingProfit)?y.operatingProfit/1e8:null)}（${esc(y.counts?.operatingProfit??'—')}）</td><td>${fmt(y.eps)}（${esc(y.counts?.eps??'—')}）</td><td>${finite(y.eps)&&y.eps>0?fmt(selected.price/y.eps)+' 倍':'不适用'}</td></tr>`).join('')}</tbody></table></div><p class="muted">采集时间：${esc(f.collectedAt?.replace('T',' ').slice(0,19))} UTC · 已返回研报中最近发布日期：${esc(f.latestReportDate||'未知')}。不同指标机构数不同；汇总值包含不同日期的预测，不代表所有机构的预测都在该日更新。</p>`:'<p class="pending">暂无可展示的公司预测。不会用其他公司的数据或固定增速代替。</p>'}<p class="muted">${f?.status==='error_cached'?'本次抓取失败，显示旧快照。 ':''}预测 EPS 只用于展示前瞻市盈率，不用于替代营收增速；市盈率也不是目标价。</p>${f?.sourceUrl?`<a class="forecast-source" href="${esc(f.sourceUrl)}" target="_blank" rel="noopener">东方财富 · 公司盈利预测来源 ↗</a>`:''}`;
}
function renderAssumptions() {
  const hasPath=Boolean(assumptions.scenarios[1].revenuePath), first=Number(selected.financials.reportDate?.slice(0,4))+1;
  const regular=(s,i)=>Object.entries(assumptionLabels).filter(([k])=>!hasPath||!['growth','margin'].includes(k)).map(([key,label])=>`<div class="field-row"><label for="${s.name}-${key}">${label}<small class="param-source">${assumptionSource(key,i)}</small></label><div class="input-unit"><input id="${s.name}-${key}" data-scenario="${i}" data-param="${key}" type="number" step="any" value="${finite(s[key])?Number((s[key]*100).toFixed(5)):''}" placeholder="请填写" aria-label="${labels[s.name]}${label}"><span>%</span></div></div>`).join('');
  const path=(s,i)=>hasPath?`<div class="path-fields"><p class="muted">${i===1?'基准营收采用机构汇总；EBIT 近似利润率加回历史财务费用比例。':'营收乘以 '+(i===0?'90%':'110%')+'；利润率'+(i===0?'减去':'加上')+'其绝对值的 10%，属于模型扰动，并非机构最低／最高预测。'}</p>${s.revenuePath.map((r,j)=>`<fieldset><legend>${first+j} · ${j<assumptions.forecastYears?'机构数据＋口径假设':'模型外推，非机构预测'}</legend><div class="field-row"><label for="${s.name}-rev-${j}">营收 / 亿元</label><input id="${s.name}-rev-${j}" class="path-input" type="number" step="any" data-path="revenuePath" data-index="${j}" data-owner="${i}" value="${r/1e8}" aria-label="${labels[s.name]}${first+j}营收"></div><div class="field-row"><label for="${s.name}-margin-${j}">EBIT 近似利润率 / %</label><input id="${s.name}-margin-${j}" class="path-input" type="number" step="any" data-path="marginPath" data-index="${j}" data-owner="${i}" value="${s.marginPath[j]*100}" aria-label="${labels[s.name]}${first+j}EBIT利润率"></div></fieldset>`).join('')}</div>`:'';
  $('assumption-fields').innerHTML=`<p class="muted">${hasPath?'已接入逐年机构预测。未覆盖年份的营收增速线性回落至初始永续增长率，利润率维持最后预测年；这些外推是模型假设，可逐年修改。修改下方永续增长率不会自动重写已生成的逐年营收。':'没有可采用的连续机构预测。营收增速与利润率留空，只有填写自己的预测并接受其余假设后才能试算。'}</p><div class="assumption-grid">${assumptions.scenarios.map((s,i)=>`<div class="scenario-form"><h3>${labels[s.name]} <span class="tiny">${['BEAR','BASE','BULL'][i]}</span></h3>${path(s,i)}${regular(s,i)}</div>`).join('')}</div><div class="duration-fields"><div class="field-row"><label for="advantage-years">假设竞争优势持续期</label><div class="input-unit"><input id="advantage-years" type="number" min="0" max="100" step="1" value="${assumptions.advantageYears}"><span>年</span></div></div><div class="field-row"><label for="sustained-growth">反向推演的持续增速</label><div class="input-unit"><input id="sustained-growth" type="number" step="0.1" value="${assumptions.sustainedGrowth*100}"><span>%</span></div></div></div><p class="muted">WACC、终值 ROIC、永续增长率、概率和反向推演持续期仍是研究假设。折旧、资本支出及营运资本比例参考历史，并非机构现金流预测。历史有效税率低于 5% 或高于 40% 时留空，请按公司长期情况填写。</p>`;
  $('edit-status').textContent='请检查预测路径及未覆盖的假设';
}
function readInputs() {
  document.querySelectorAll('[data-scenario]').forEach(input=>{
    assumptions.scenarios[Number(input.dataset.scenario)][input.dataset.param]=input.value.trim()===''?null:Number(input.value)/100;
  });
  document.querySelectorAll('[data-path]').forEach(input=>{
    assumptions.scenarios[Number(input.dataset.owner)][input.dataset.path][Number(input.dataset.index)]=input.value.trim()===''?null:Number(input.value)*(input.dataset.path==='revenuePath'?1e8:.01);
  });
  assumptions.advantageYears=$('advantage-years').value.trim()===''?null:Number($('advantage-years').value);
  assumptions.sustainedGrowth=$('sustained-growth').value.trim()===''?null:Number($('sustained-growth').value)/100;
}
function workingCompany(){return {...selected,financials:{...selected.financials,...edits}};}
function calculate() {
  if(!selected)return;
  readInputs();
  const c=workingCompany();result=$('assumptions-reviewed').checked?evaluate({...c,historical:{...c.historical,roic:finite(c.historical?.roic)?c.historical.roic/100:null}},assumptions):{status:'BLOCKED',errors:['请先检查逐年预测和缺失项，并在模型假设下方勾选接受其余试算假设。'],scenarios:[]};
  renderResult(c);
  $('edit-status').textContent=result.status==='BLOCKED'?'尚未生成估值 · 请检查缺失项与假设确认':`已按当前假设计算 · ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
}
function messageText(v){
  if(typeof v==='string')return v;
  if(v?.code==='INVALID_PATH')return '逐年预测必须完整填写五年：营收需大于 0，EBIT 利润率需在 -100% 至 100% 之间。';
  const translated={WACC_NOT_ABOVE_GROWTH:'折现率 WACC 必须高于永续增长率。',PROBABILITY_TOTAL:'三种情景的概率合计必须为 100%。',TERMINAL_REINVESTMENT:'非零终值增长需要正 ROIC，且正增长必须低于终值 ROIC。',NEGATIVE_TERMINAL_FCFF:'终值自由现金流为负，此模型无法给出有效估值。',INVALID_SCENARIOS:'需要完整的悲观、基准和乐观三个情景。',INVALID_DATE:'行情日期或财报日期无效。'};
  const path=v?.path?.split('.')||[], key=path.at(-1);
  const common={advantageYears:'竞争优势持续期',sustainedGrowth:'反向推演持续增速',price:'行情价格'};
  const prefix=path[1]==='scenarios'?(labels[assumptions.scenarios[Number(path[2])]?.name]||'情景')+' · ':'';
  const field=prefix+((path[0]==='assumptions'?assumptionLabels[key]:factLabels[key])||common[key]||key||'输入');
  if(v?.code==='NONFINITE_VALUE'||v?.code==='MISSING_FACT')return `${field}缺失或不是有效数字，请补充。`;
  if(v?.code==='INVALID_BOUND')return `${field}超出允许范围，请检查。竞争优势期需为 0–100 的整数，持续增速需大于 -100% 且不超过 20%。`;
  return translated[v?.code]||v?.message||JSON.stringify(v);
}
function renderResult(c) {
  const r=result, blocked=r.status==='BLOCKED';
  $('model-state').className=`badge ${blocked?'blocked':'warning'}`;
  $('model-state').textContent=blocked?'BLOCKED · 等待输入':'DRAFT_REVIEW · 待复核';
  const missing=Object.keys(factLabels).filter(k=>!finite(c.financials[k]));
  let notice='';
  if(c.method!=='fcff'){
    notice=`<strong>此公司的估值方法需要单独处理</strong>${c.method==='financial'?'银行、保险和券商应使用股利折现、剩余收益或适当的股权模型。':c.method==='cyclical'?'周期行业需要先正常化盈利，不能直接外推单一年度。':c.method==='nav'?'房地产等资产型企业需要资产净值或分部估值。':'当前证据不足以确认适用方法。'} 已保留行情和可取得的财报，不输出普通 DCF 价格。`;
  }else if(blocked){
    notice=`<strong>先补齐依据，再讨论价值。</strong>${missing.length?'尚缺：'+missing.map(k=>factLabels[k]).join('、')+'。可在下方财报输入区补充。<br>':''}${(r.errors||[]).map(messageText).map(esc).join('；')}`;
    const eligible=missing.filter(k=>finite(c.proposals?.[k]?.value));
    if(eligible.length) notice+=`<br>已披露合计：${eligible.map(k=>factLabels[k]+' '+fmt(c.proposals[k].value/1e8)+' 亿元').join('、')}。可以采用这些合计进行假设试算；未披露部分仍未核实。<br><button id="use-proposals">采用已披露合计作假设 →</button>`;
  }else{
    notice=`<strong>当前结果是接受假设后的条件试算。</strong>${assumptions.scenarios[1].revenuePath?'明确预测期含机构营收预测、营业利润口径转换及模型外推。':'本次使用用户填写的增长与利润率。'}折现率、税率、投入和终值仍需判断。模型以 ${esc(c.financials.reportDate)} 年末财报为基期，未滚动扣除已过去期间的现金流，不能直接视为今日公允价值；与当前行情比较仅供研究。${Object.keys(edits).length?' 本次包含用户提供的 '+Object.keys(edits).map(k=>factLabels[k]).join('、')+'。':''}`;
  }
  $('model-notice').innerHTML=`<div class="notice">${notice}</div>`;
  const ss=r.scenarios||[];
  $('valuation-cards').innerHTML=assumptions.scenarios.map(s=>{
    const v=ss.find(x=>x.name===s.name), val=v?.valuePerShare;
    return `<article class="value-card ${s.name}"><div class="card-top"><span>${labels[s.name]}</span><small>权重 ${pct(s.probability)}</small></div><h3><small>¥</small>${fmt(val)}</h3><p>${finite(val)&&c.price>0?'相对现价 '+(val/c.price>=1?'+':'')+fmt((val/c.price-1)*100,1)+'%':'等待完整输入后计算'}</p><div class="scenario-detail"><span>${s.revenuePath?'逐年预测':'增长 '+pct(s.growth)}</span><span>WACC ${pct(s.wacc)}</span></div></article>`;
  }).join('');
  if(!blocked && ss.length){
    const vals=ss.map(v=>v.valuePerShare), lo=Math.min(...vals),hi=Math.max(...vals),min=Math.min(lo,c.price)*.8,max=Math.max(hi,c.price)*1.12;
    const position=v=>Math.max(0,Math.min(100,(v-min)/(max-min||1)*100));
    $('range-chart').innerHTML=`<div class="range-wrap"><div class="range-heading"><span>概率加权试算值 <b>¥ ${fmt(r.weightedValue)}</b></span><span>情景区间 ${fmt(lo)} — ${fmt(hi)}</span></div><div class="range-track" role="img" aria-label="情景估值区间 ${fmt(lo)} 至 ${fmt(hi)} 元，现价 ${fmt(c.price)} 元"><div class="range-band" style="left:${position(lo)}%;width:${position(hi)-position(lo)}%"></div><div class="range-point" style="left:${position(r.weightedValue)}%"></div><div class="range-price" style="left:${position(c.price)}%"><span>现价 ¥${fmt(c.price)}</span></div></div></div>`;
  }else $('range-chart').innerHTML='';
  renderReverse(c,r);renderQuality(c,r);renderSensitivity(r);renderBridge(c,r);renderForecast(r);
  $('model-notice').querySelector('#use-proposals')?.addEventListener('click',()=>{
    for(const [k,p] of Object.entries(c.proposals||{}))if(!finite(c.financials[k])&&finite(p.value))edits[k]=p.value;
    $('assumptions-reviewed').checked=false;renderFacts();calculate();
  });
}
function renderReverse(c,r) {
  const rev=r.reverse||{};
  $('reverse').innerHTML=r.status==='BLOCKED'?'<p class="pending">补全估值输入后，反推当前价格需要的增长条件。</p>':`<div class="reverse-grid"><div><p class="metric-label">隐含永续增长率</p><p class="metric-value">${rev.terminalGrowth?.status==='AMBIGUOUS'?'存在多解':pct(rev.impliedTerminalGrowth)}</p><p class="metric-caption">${rev.terminalGrowth?.status==='AMBIGUOUS'?'候选：'+rev.terminalGrowth.roots.map(pct).join(' / '):'模型假设 '+pct(assumptions.scenarios[1].terminalGrowth)}</p></div><div><p class="metric-label">隐含增长持续期</p><p class="metric-value">${fmt(rev.impliedDurationYears,1)}<small>年</small></p><p class="metric-caption">按 ${pct(assumptions.sustainedGrowth)} 增长推演</p></div></div><div class="callout">${!finite(rev.impliedDurationYears)?'当前设定下持续期不可达或无有效解。':rev.impliedDurationYears>assumptions.advantageYears?'价格要求的增长持续期超过你设定的竞争优势期限。':'推演持续期位于你设定的竞争优势期限内，仍需证据支持。'}<br>持续期含 5 年明确预测；之后保持末年经济结构外推。持续增速为用户假设，不是机构一致预期。</div>`;
}
function renderQuality(c,r) {
  const base=r.scenarios?.find(s=>s.name==='base'), h=c.historical||{}, cf=finite(h.operatingCashFlow)&&h.netProfit>0?h.operatingCashFlow/h.netProfit:null;
  const spread=finite(h.roic)?h.roic/100-assumptions.scenarios[1].wacc:null;
  const checks=[['资本回报与资金成本',finite(spread)?`历史 ROIC − 假设 WACC：${pct(spread)}`:'缺少历史 ROIC',finite(spread)?spread>0?'ok':'bad':'warn',finite(spread)?spread>0?'正利差':'负利差':'待补充'],
    ['现金转化质量',finite(cf)?`经营现金流 / 净利润：${fmt(cf)} 倍`:'现金流或净利润不可用',finite(cf)&&cf>=.8?'ok':'warn',finite(cf)?cf>=.8?'参考达标':'需关注':'待补充'],
    ['终值依赖',finite(base?.terminalShare)?`终值占企业价值 ${pct(base.terminalShare)}`:'计算后检查终值占比',finite(base?.terminalShare)&&base.terminalShare<=.75?'ok':'warn',finite(base?.terminalShare)?base.terminalShare>.75?'偏高':'可观察':'待计算'],
    ['稀释、杠杆与竞争优势','未来稀释与优势期限尚无独立证据','warn','待复核'],
    ['机构预测与 PEG',forecasts[c.code]?.years?.some(y=>y.kind==='estimate')?'已接入机构预测；EPS、营收与利润口径分别展示，不自动据此生成 PEG 目标价。':'暂无机构预测；历史增速不替代未来预测。','warn','分别核对']];
  $('quality').innerHTML=checks.map(([name,desc,state,tag])=>`<div class="quality-row"><div>${name}<small>${esc(desc)}</small></div><span class="quality-state ${state}">${tag}</span></div>`).join('');
  if(r.warnings?.length)$('quality').innerHTML+=`<details class="fact-note"><summary>查看模型检查 ${r.warnings.length} 项</summary>${r.warnings.map(messageText).map(esc).join('<br>')}</details>`;
}
function renderSensitivity(r) {
  const s=r.sensitivity;
  if(r.status==='BLOCKED'||!s){$('sensitivity').innerHTML='<p class="pending">有效模型生成后显示 WACC × 永续增长率矩阵。</p>';return;}
  $('sensitivity').innerHTML=`<table><thead><tr><th>WACC ↓ / g →</th>${s.growthRates.map(g=>`<th>${pct(g)}</th>`).join('')}</tr></thead><tbody>${s.waccs.map((w,i)=>`<tr><th>${pct(w)}</th>${s.values[i].map((v,j)=>`<td class="${i===2&&j===2?'base-cell':''}">${fmt(v,1)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderBridge(c,r) {
  const b=r.scenarios?.find(s=>s.name==='base');
  if(!b){$('bridge').innerHTML='<p class="pending">企业价值 ＋ 现金 − 债务 − 少数股东权益<br>再除以股数，得到每股价值。</p>';return;}
  $('bridge').innerHTML=[['明确预测期现值',b.pvExplicit],['终值现值',b.pvTerminal],['企业价值 EV',b.enterpriseValue],['＋ 账面货币资金',c.financials.cash],['− 有息债务',c.financials.debt],['− 少数股东权益',c.financials.minorityInterest],['归属股权价值',b.equityValue]].map(([k,v])=>`<div class="bridge-row"><span>${k}</span><b>${fmt(v/1e8)} <small>亿</small></b></div>`).join('')+`<div class="bridge-row total"><span>基准情景 · 每股价值</span><b>¥ ${fmt(b.valuePerShare)}</b></div>`;
}
function renderForecast(r) {
  const b=r.scenarios?.find(s=>s.name==='base');
  $('forecast').innerHTML=b?`<table><thead><tr><th>基准情景 · 亿元</th>${b.forecast.map((_,i)=>`<th>${Number(selected.financials.reportDate.slice(0,4))+i+1} 年</th>`).join('')}</tr></thead><tbody>${[['营收','revenue'],['EBIT','ebit'],['税后经营利润','nopat'],['折旧摊销','depreciation'],['资本支出','capex'],['营运资本增加','deltaNwc'],['自由现金流 FCFF','fcff']].map(([name,key])=>`<tr><th>${name}</th>${b.forecast.map(y=>`<td>${fmt(y[key]/1e8)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:'<p class="pending">补全输入后显示经营预测。</p>';
}

$('search').addEventListener('input',e=>listStocks(e.target.value));
$('search').addEventListener('keydown',e=>{if(e.key==='Enter')$('stock-list').querySelector('button')?.click();});
$('stock-list').addEventListener('click',e=>{const b=e.target.closest('[data-code]');if(b)selectCompany(b.dataset.code);});
$('facts').addEventListener('input',e=>{const k=e.target.dataset.fact;if(!k)return;edits[k]=e.target.value.trim()===''?null:Number(e.target.value)*(k==='taxRate'?.01:1e8);e.target.classList.add('edited');e.target.parentElement.querySelector('small').textContent='用户提供 · '+(k==='taxRate'?'%':k==='shares'?'亿股':'亿元');$('edit-status').textContent='输入已改变 · 请重新计算';invalidateResult();});
$('assumption-fields').addEventListener('input',()=>{$('edit-status').textContent='假设已改变 · 请重新检查并试算';invalidateResult();});
function invalidateResult(){if(!selected)return;$('assumptions-reviewed').checked=false;result={status:'BLOCKED',errors:['参数已修改，请重新检查并接受假设后试算。'],scenarios:[],warnings:[]};renderResult(workingCompany());}
$('assumptions-reviewed').addEventListener('change',()=>{if(!$('assumptions-reviewed').checked)invalidateResult();});
$('calculate').addEventListener('click',calculate);
$('reset').addEventListener('click',()=>{edits={};assumptions=defaultAssumptions(selected);$('assumptions-reviewed').checked=false;renderFacts();renderAssumptions();calculate();});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)){e.preventDefault();$('search').focus();}});

try {
  const response=await fetch(new URL('./data/companies.json',import.meta.url),{cache:'no-cache'});
  if(!response.ok)throw new Error('数据请求失败 '+response.status);
  const payload=await response.json();companies=payload.companies;metadata=payload.meta;
  try {
    const f=await fetch(new URL('./data/forecasts.json',import.meta.url),{cache:'no-cache'});
    if(!f.ok)throw new Error('预测数据不可用');
    const fp=await f.json();forecasts=fp.companies||{};forecastMetadata=fp.meta||{};
    if(forecastMetadata.errors?.length){$('load-error').hidden=false;$('load-error').textContent='本次部分机构预测采集失败，已保留旧快照及原始日期。请留意各公司的预测采集时间。';}
  }catch {forecasts={};$('load-error').hidden=false;$('load-error').textContent='机构预测快照加载失败。不会自动填入统一增速，请稍后刷新或手动输入自己的预测。';}
  if(!companies||!Object.keys(companies).length)throw new Error('数据快照为空');
  $('stock-count').textContent=`${Object.keys(companies).length.toLocaleString()} 个条目`;
  $('snapshot-time').textContent='采集于 '+new Date(metadata.collectedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  if(metadata.errors?.length){$('load-error').hidden=false;$('load-error').textContent='部分数据源本次更新失败，已保留上次成功数据。请以个股行情日期和报告期为准。';}
  const hash=location.hash.slice(1), queryCode=new URLSearchParams(location.search).get('stock');
  selectCompany(companies[hash]?hash:companies[queryCode]?queryCode:companies['600519']?'600519':Object.keys(companies)[0]);
} catch(error) {
  $('load-error').hidden=false;$('load-error').textContent='暂时无法载入数据。请刷新重试；估值不会使用演示数字替代。';
  $('stock-list').innerHTML='<p class="empty-state">市场数据未载入</p>';$('stock-count').textContent='连接失败';console.error(error);
}
