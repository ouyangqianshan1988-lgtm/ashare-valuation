"""Fetch dated public snapshots; no credentials, no silent null-to-zero conversion."""
import argparse
import concurrent.futures
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'site' / 'data'
API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/'}
COMMON = ['SECURITY_CODE','SECURITY_NAME_ABBR','REPORT_DATE','NOTICE_DATE']
TABLES = {
 'industry': ('RPT_DMSK_FN_INCOME', COMMON + ['INDUSTRY_NAME']),
 'income': ('RPT_F10_FINANCE_GINCOME', COMMON + ['ORG_TYPE','CURRENCY','OPERATE_INCOME','TOTAL_OPERATE_INCOME','OPERATE_PROFIT','FINANCE_EXPENSE','TOTAL_PROFIT','INCOME_TAX','PARENT_NETPROFIT','DILUTED_EPS']),
 'balance': ('RPT_F10_FINANCE_GBALANCE', COMMON + ['MONETARYFUNDS','SHORT_LOAN','LONG_LOAN','BOND_PAYABLE','LEASE_LIAB','NONCURRENT_LIAB_1YEAR','SHORT_FIN_PAYABLE','MINORITY_EQUITY','SHARE_CAPITAL','INVENTORY','NOTE_ACCOUNTS_RECE','NOTE_ACCOUNTS_PAYABLE','TOTAL_ASSETS','TOTAL_LIABILITIES','TOTAL_PARENT_EQUITY']),
 'cashflow': ('RPT_F10_FINANCE_GCASHFLOW', COMMON + ['FA_IR_DEPR','IA_AMORTIZE','LPE_AMORTIZE','USERIGHT_ASSET_AMORTIZE','CONSTRUCT_LONG_ASSET','NETCASH_OPERATE','NETPROFIT']),
 'metrics': ('RPT_F10_FINANCE_MAINFINADATA', COMMON + ['ROIC','TOTAL_SHARE','PER_EBIT','TOTALOPERATEREVETZ','EPSJB','EPSXS']),
}
DEBT_FIELDS = ['SHORT_LOAN','LONG_LOAN','BOND_PAYABLE','LEASE_LIAB','NONCURRENT_LIAB_1YEAR','SHORT_FIN_PAYABLE']
DA_FIELDS = ['FA_IR_DEPR','IA_AMORTIZE','LPE_AMORTIZE','USERIGHT_ASSET_AMORTIZE']

def number(value):
    if value is None or isinstance(value, bool): return None
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError): return None

def strict_sum(*values):
    parsed = [number(v) for v in values]
    return None if any(v is None for v in parsed) else sum(parsed)

def latest_visible(rows, cutoff):
    result = {}
    for row in rows:
        code = row.get('SECURITY_CODE','')
        report = str(row.get('REPORT_DATE') or '')[:10]
        notice = str(row.get('NOTICE_DATE') or '')[:10]
        if not re.fullmatch(r'\d{6}', code) or not notice or notice > cutoff or not report or report > cutoff: continue
        previous = result.get(code, {})
        if (report, notice) > (str(previous.get('REPORT_DATE',''))[:10],str(previous.get('NOTICE_DATE',''))[:10]): result[code] = row
    return result

def merge_quotes(old, new):
    merged = dict(old)
    for code, quote in new.items():
        item = {**old.get(code,{}), **quote}
        if 'financials' in item and number(quote.get('shares')) is not None and quote['shares'] > 0:
            item['financials'] = {**item['financials'], 'shares':quote['shares']}
            item['missing'] = [k for k,v in item['financials'].items() if v is None]
        if 'sources' in item:
            item['sources'] = [{**s, **({'date':quote['quoteDate']} if '腾讯' in s.get('name','') and quote.get('quoteDate') else {})} for s in item['sources']]
        merged[code] = item
    return merged

def rows_from_payload(payload):
    result = payload.get('result')
    if payload.get('success') is not True or not isinstance(result, dict) or not isinstance(result.get('data'), list):
        raise ValueError('Provider returned an invalid or unsuccessful payload')
    return result['data']

def request(url, encoding='utf-8'):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=25) as r:
                return r.read().decode(encoding)
        except Exception:
            if attempt == 2: raise
            time.sleep(attempt + 1)

def report_page(name, fields, year, page=1):
    params = dict(reportName=name, columns=','.join(fields), filter=f'(REPORT_DATE=\'{year}-12-31\')',
                  pageSize=500, pageNumber=page, sortColumns='SECURITY_CODE', sortTypes='1')
    payload = json.loads(request(API + '?' + urllib.parse.urlencode(params)))
    rows = rows_from_payload(payload)
    return rows, int(payload['result']['pages'])

def fetch_table(key, year, cutoff):
    name, fields = TABLES[key]
    rows, pages = report_page(name, fields, year)
    # Four in-flight requests and retry backoff keep collection bounded.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for batch, _ in pool.map(lambda p: report_page(name, fields, year, p), range(2, pages+1)): rows.extend(batch)
    return latest_visible(rows, cutoff)

def symbol(code):
    return ('sh' if code.startswith('6') else 'sz' if code.startswith(('0','3')) else 'bj') + code

def parse_quotes(raw):
    result = {}
    for match in re.finditer(r'v_\w+="([^"]*)"', raw):
        f = match.group(1).split('~')
        if len(f) < 47 or not re.fullmatch(r'\d{6}', f[2]): continue
        stamp = f[30]
        if not re.fullmatch(r'\d{14}', stamp): continue
        price = number(f[3])
        if price is None or price <= 0: continue
        code = f[2]
        result[code] = dict(code=code, name=f[1], price=price, changePct=number(f[32]),
            quoteDate=f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}', quoteTime=f'{stamp[8:10]}:{stamp[10:12]}:{stamp[12:14]}',
            pe=number(f[39]), pb=number(f[46]), marketCap=number(f[45])*1e8 if number(f[45]) is not None else None,
            shares=number(f[73]) if len(f)>73 else None)
    return result

def fetch_quotes(codes):
    batches = [codes[i:i+80] for i in range(0,len(codes),80)]
    result, errors = {}, []
    def batch(items):
        try:
            rows = parse_quotes(request('https://qt.gtimg.cn/q='+','.join(map(symbol,items)), 'gb18030'))
            return rows, None if rows else 'EmptyQuoteResponse'
        except Exception as exc: return {}, type(exc).__name__
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for rows, error in pool.map(batch, batches):
            result.update(rows)
            if error: errors.append(error)
    return result, errors

def route(industry, name, org):
    text = industry + name + org
    if any(w in text for w in ['银行','保险','证券','多元金融','信托']): return 'financial'
    if any(w in text for w in ['房地产','地产开发']): return 'nav'
    if any(w in text for w in ['煤炭','钢铁','有色','采掘','石油','化工','化学原料','化学制品','航运','水泥','光伏','养殖','猪','锂矿']): return 'cyclical'
    return 'fcff' if industry and org == '通用' else 'unknown'

def disclosed_sum(row, fields):
    values = [number(row.get(k)) for k in fields]
    known = [n for n in values if n is not None]
    return (sum(known) if known else None), [k for k,v in zip(fields,values) if v is None]

def normalize(code, tables, quote, collected):
    i,b,c,m,d = [tables.get(k,{}).get(code,{}) for k in ['income','balance','cashflow','metrics','industry']]
    name = quote.get('name') or d.get('SECURITY_NAME_ABBR') or i.get('SECURITY_NAME_ABBR') or code
    dates = [str(x.get('REPORT_DATE') or '')[:10] for x in [i,b,c,m]]
    same_period = len(set(dates)) == 1 and bool(dates[0])
    revenue = number(i.get('OPERATE_INCOME'))
    totalprofit = number(i.get('TOTAL_PROFIT'))
    tax = number(i.get('INCOME_TAX'))
    # Operating profit + finance expense is a disclosed operating EBIT proxy;
    # non-recurring/investment income is not normalized automatically.
    ebit = strict_sum(i.get('OPERATE_PROFIT'), i.get('FINANCE_EXPENSE'))
    debt, missing_debt = disclosed_sum(b, DEBT_FIELDS)
    da, missing_da = disclosed_sum(c, DA_FIELDS)
    rece, inv, payable = [number(b.get(k)) for k in ['NOTE_ACCOUNTS_RECE','INVENTORY','NOTE_ACCOUNTS_PAYABLE']]
    nwc = rece + inv - payable if all(v is not None for v in [rece,inv,payable]) else None
    f = dict(revenue=revenue, ebit=ebit, taxRate=tax/totalprofit if tax is not None and totalprofit and totalprofit>0 else None,
        depreciation=None if missing_da else da, capex=number(c.get('CONSTRUCT_LONG_ASSET')), workingCapital=nwc,
        cash=number(b.get('MONETARYFUNDS')), debt=None if missing_debt else debt, minorityInterest=number(b.get('MINORITY_EQUITY')),
        shares=quote.get('shares') or number(m.get('TOTAL_SHARE')), reportDate=dates[0] or None)
    if not same_period:
        f = {k:(v if k == 'reportDate' else None) for k,v in f.items()}
    industry = d.get('INDUSTRY_NAME') or ''
    sources = [dict(name='腾讯财经 · 行情',url='https://gu.qq.com/'+symbol(code),date=quote.get('quoteDate')),
        dict(name='东方财富 · 财务报表',url='https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code='+symbol(code),date=f['reportDate']),
        dict(name='巨潮资讯 · 原始公告核对',url='https://www.cninfo.com.cn/new/fulltextSearch?keyWord='+code,date=None)]
    proposals = {}
    if same_period and missing_debt and debt is not None: proposals['debt'] = {'value':debt,'reason':'仅汇总已披露借款、债券、租赁及一年内到期负债；未披露项目尚未核实。','missing':missing_debt}
    if same_period and missing_da and da is not None: proposals['depreciation'] = {'value':da,'reason':'仅汇总已披露折旧摊销；未披露项目尚未核实。','missing':missing_da}
    missing = [k for k,v in f.items() if v is None]
    return dict(code=code,name=name,industry=industry,method=route(industry,name,i.get('ORG_TYPE','')),price=quote.get('price'),quoteDate=quote.get('quoteDate'),quoteTime=quote.get('quoteTime'),
        changePct=quote.get('changePct'),pe=quote.get('pe'),pb=quote.get('pb'),marketCap=quote.get('marketCap'),financials=f,proposals=proposals,missing=missing,
        historical=dict(financeExpense=number(i.get('FINANCE_EXPENSE')) if same_period else None,roic=number(m.get('ROIC')),revenueGrowth=number(m.get('TOTALOPERATEREVETZ')),operatingCashFlow=number(c.get('NETCASH_OPERATE')),netProfit=number(c.get('NETPROFIT'))),
        noticeDate=max([str(x.get('NOTICE_DATE') or '')[:10] for x in [i,b,c,m]]),collectedAt=collected,sources=sources,
        notes=['年度基期模型，非 TTM；较新季报未并入预测基期。','EBIT 为营业利润加财务费用近似值，未剔除投资收益及非经常项目。','营运资本口径：存货＋应收票据及账款－应付票据及账款；不含全部经营项目。','现金使用账面货币资金，需核对受限资金；少数股东权益用账面值。','股数采用行情总股本，未核实未来稀释；多地上市价格差异未建模。'])

def write_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf-8')
    temp.replace(path)

def build_health(previous, stamp, year, total, quotes, tables, errors):
    failed = not quotes and not any(tables.values())
    return dict(collectedAt=previous.get('collectedAt') if failed else stamp,lastAttemptAt=stamp,
        annualYear=previous.get('annualYear',year) if failed else year,total=total,freshQuotes=len(quotes),errors=errors,
        providerStatus='failed' if failed else 'partial' if errors else 'ok',source='腾讯财经 / 东方财富',schemaVersion=1)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--year',type=int)
    parser.add_argument('--limit',type=int,default=0)
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    cutoff = now.date().isoformat()
    year = args.year or (now.year-1 if now.month>=5 else now.year-2)
    stamp = now.isoformat()
    DATA.mkdir(parents=True,exist_ok=True)
    oldpath = DATA/'companies.json'
    previous = json.loads(oldpath.read_text(encoding='utf8')) if oldpath.exists() else {}
    old = previous.get('companies',{})
    tables, failures = {}, []
    for key in TABLES:
        try:
            tables[key] = fetch_table(key,year,cutoff)
            print(f'{key}: {len(tables[key])} records',flush=True)
        except Exception as exc:
            failures.append(f'{key}: {type(exc).__name__}')
            tables[key] = {}
    # Industry table is the A-share financial universe; OTC instruments are excluded.
    codes = sorted(set(tables['industry']) | set(old))
    if args.limit: codes = codes[:args.limit]
    quotes, quote_errors = fetch_quotes(codes)
    failures.extend(['quote: '+e for e in quote_errors])
    companies = dict(old)
    for code in codes:
        q = quotes.get(code) or {k:old.get(code,{}).get(k) for k in ['price','quoteDate','quoteTime','changePct','pe','pb','marketCap']}
        if not q.get('price') and code not in old: continue
        if all(code in tables[k] for k in ['income','balance','cashflow','metrics']):
            companies[code] = normalize(code,tables,q,stamp)
        elif code in old:
            companies[code] = merge_quotes({code:old[code]}, {code:q})[code]
        else:
            companies[code] = normalize(code,tables,q,stamp)
    if not companies: raise SystemExit('No valid data obtained; existing dataset was not overwritten.')
    health = build_health(previous.get('meta',{}),stamp,year,len(companies),quotes,tables,failures)
    write_json(oldpath,dict(meta=health,companies=companies))
    write_json(DATA/'health.json',health)
    print(json.dumps(health,ensure_ascii=True),flush=True)
    if not quotes and not any(tables.values()): raise SystemExit('All providers failed; cached data retained.')

if __name__ == '__main__': main()
