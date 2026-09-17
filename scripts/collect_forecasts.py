"""Dated Eastmoney consensus; absolute CNY amounts, EPS CNY/share, no extrapolation."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import date, datetime, timezone
import gzip
import json
import math
from pathlib import Path
import re
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DATA = Path(__file__).resolve().parents[1] / 'site' / 'data'
API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
BASE = 'https://emweb.securities.eastmoney.com/PC_HSF10/ProfitForecast/'
FIELDS = {'revenue': 'TOTAL_OPERATE_INCOME', 'operatingProfit': 'OPERATE_PROFIT', 'eps': 'EPS', 'netProfit': 'PARENT_NETPROFIT'}

def number(value):
    if value is None or isinstance(value, bool): return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError): return None

def symbol(code):
    if not isinstance(code, str) or not re.fullmatch(r'\d{6}', code): raise ValueError('Invalid security code')
    return ('SH' if code.startswith('6') else 'BJ' if code.startswith(('4', '8', '9')) else 'SZ') + code

def empty_company(code, now):
    return dict(code=code, collectedAt=now, latestReportDate=None, sourceUrl=BASE+'Index?type=web&code='+symbol(code), status='unavailable', years=[])

def normalize(code, payload, now):
    result = empty_company(code, now)
    if not isinstance(payload, dict) or not isinstance(payload.get('yctj_list'), list): raise ValueError('Invalid forecast response')
    today = date.fromisoformat(now[:10])
    # Reject mixed-company payloads, including report-date and other auxiliary tables.
    for rows in payload.values():
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict): raise ValueError('Invalid forecast row')
                if row.get('SECURITY_CODE') != code: raise ValueError('Forecast security mismatch')
    seen = set()
    for row in payload['yctj_list']:
        raw_year = number(row.get('YEAR'))
        if raw_year is None or raw_year != int(raw_year) or not 2000 <= raw_year <= today.year + 10: raise ValueError('Invalid forecast year')
        year = int(raw_year)
        mark = row.get('YEAR_MARK')
        if mark not in ('A', 'E') or year in seen: raise ValueError('Invalid or duplicate forecast year/kind')
        seen.add(year)
        item = {'year': year, 'kind': 'actual' if mark == 'A' else 'estimate', 'counts': {}}
        for name, field in FIELDS.items():
            item[name] = number(row.get(field))
            count = number(row.get(field+'_COUNT'))
            item['counts'][name] = int(count) if count is not None and count >= 0 and count == int(count) else None
        result['years'].append(item)
    dates = []
    for table in ('jgyc', 'ycmx'):
        for row in payload.get(table, []):
            if not row.get('ORG_CODE') or row['ORG_CODE'] == '00000000': continue
            raw = row.get('PUBLISH_DATE')
            if raw is None: continue
            try: parsed = date.fromisoformat(str(raw)[:10])
            except ValueError: raise ValueError('Invalid report date')
            if parsed > today or parsed.year < 2000: raise ValueError('Report date outside valid range')
            dates.append(parsed.isoformat())
    result['latestReportDate'] = max(dates) if dates else None
    result['years'].sort(key=lambda row: row['year'])
    if any(row['kind'] == 'estimate' for row in result['years']): result['status'] = 'ok'
    return result

def failed_company(code, previous, now):
    result = deepcopy(previous) if previous else empty_company(code, None)
    result['status'] = 'error_cached' if previous else 'unavailable'
    return result

def failed_summary(previous, now, error):
    result = deepcopy(previous)
    result.setdefault('companies', {})
    result.setdefault('meta', {})
    result['meta'].update(lastAttemptAt=now, errors=[str(error)], providerStatus='error_cached')
    return result

def fetch(url):
    for attempt in range(2):
        try:
            request = Request(url, headers={'User-Agent':'Mozilla/5.0', 'Referer':'https://data.eastmoney.com/', 'Accept-Encoding':'gzip'})
            with urlopen(request, timeout=15) as response:
                raw = response.read()
                if raw[:2] == b'\x1f\x8b': raw = gzip.decompress(raw)
                return json.loads(raw.decode('utf-8-sig'))
        except Exception:
            if attempt: raise
            time.sleep(0.3)

def coverage():
    codes = set()
    page = 1
    expected_count = None
    while True:
        payload = fetch(API+'?'+urlencode(dict(reportName='RPT_WEB_RESPREDICT', columns='ALL', pageSize=500, pageNumber=page, sortColumns='SECURITY_CODE', sortTypes='1')))
        result = payload.get('result')
        if payload.get('success') is not True or not isinstance(result, dict) or not isinstance(result.get('data'), list): raise ValueError('Invalid coverage response')
        pages = result.get('pages')
        if not isinstance(pages, int) or not 1 <= pages <= 100: raise ValueError('Invalid coverage pagination')
        if expected_count is None: expected_count = result.get('count')
        for row in result['data']:
            code = row.get('SECURITY_CODE')
            symbol(code)
            codes.add(code)
        if page >= pages: break
        page += 1
    if expected_count is not None and len(codes) != expected_count: raise ValueError('Incomplete coverage response')
    return codes

def collect(previous, codes, limit=None):
    now = datetime.now(timezone.utc).isoformat()
    try: covered = coverage() & set(codes)
    except Exception as exc: return failed_summary(previous, now, exc)
    old = previous.get('companies', {})
    selected = sorted(covered)[:limit] if limit else sorted(covered)
    companies = {code: empty_company(code, now) for code in codes if code not in covered}
    companies.update({code: deepcopy(old.get(code, empty_company(code, None))) for code in covered if code not in selected})
    errors = []
    def detail(code):
        return normalize(code, fetch(BASE+'PageAjax?'+urlencode({'code':symbol(code)})), datetime.now(timezone.utc).isoformat())
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(detail, code):code for code in selected}
        for index, future in enumerate(as_completed(futures), 1):
            code = futures[future]
            try: companies[code] = future.result()
            except Exception as exc:
                companies[code] = failed_company(code, old.get(code), now)
                errors.append(code+': '+str(exc))
            if index % 100 == 0: print(f'Forecasts {index}/{len(selected)}, errors {len(errors)}', flush=True)
    return {'meta':dict(lastAttemptAt=now, collectedAt=now, errors=errors, covered=len(covered), total=len(codes), attempted=len(selected), providerStatus='partial' if errors or limit else 'ok', source='Eastmoney ProfitForecast; amounts CNY; EPS CNY/share', reportDateNote='Latest visible individual institution report date; not a per-field consensus update date.'), 'companies':companies}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0: parser.error('--limit must be positive')
    path = DATA / 'forecasts.json'
    previous = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    universe = json.loads((DATA / 'companies.json').read_text(encoding='utf-8'))['companies']
    result = collect(previous, universe, args.limit)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    temporary.replace(path)
    print(json.dumps(result['meta'], ensure_ascii=False), flush=True)
    if result['meta']['errors']: raise SystemExit(1)

if __name__ == '__main__': main()
