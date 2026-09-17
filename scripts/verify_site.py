"""Verify the deployable artifact contains real, finite and self-contained data."""
from pathlib import Path
import json
import re

root = Path(__file__).resolve().parents[1]
site = root/'site'
for name in ['index.html','styles.css','app.mjs','valuation.mjs','forecast-model.mjs','automatic-model.mjs','data/estimates.json','data/companies.json','data/health.json','data/forecasts.json']:
    assert (site/name).is_file(), f'Missing deploy artifact: {name}'
raw = (site/'data/companies.json').read_text(encoding='utf8')
payload = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
companies = payload['companies']
assert len(companies) > 0, 'Empty snapshot'
for code, c in companies.items():
    assert re.fullmatch(r'\d{6}',code), code
    assert c['code'] == code and c['name'] and c['sources'], code
    assert c['price'] is None or c['price'] > 0, code
    assert c['financials']['reportDate'] is None or re.fullmatch(r'\d{4}-\d{2}-\d{2}',c['financials']['reportDate']),code
    assert len(c['missing']) == len([k for k,v in c['financials'].items() if v is None]), code
forecasts=json.loads((site/'data/forecasts.json').read_text(encoding='utf8'),parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
for code, entry in forecasts['companies'].items():
    assert code in companies and entry['code']==code, code
    assert entry['status'] in ['ok','unavailable','error_cached','error'], code
    for row in entry.get('years',[]):
        assert row['kind'] in ['actual','estimate'] and isinstance(row['year'],int), code
        assert isinstance(row.get('counts'),dict), code
estimates=json.loads((site/'data/estimates.json').read_text(encoding='utf8'),parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
assert set(estimates['companies']) == set(companies), 'Automatic estimate coverage mismatch'
for code, entry in estimates['companies'].items():
    assert entry['method'] in ['fcff','relative','unavailable'], code
    assert entry['fieldSources'] and entry['policyVersion'], code
    summary=entry['summary']
    if entry['method'] != 'unavailable':
        assert summary['status']=='DRAFT_REVIEW' and len(summary['values'])==3, code
        assert summary['weightedValue']>0 and all(v>0 for v in summary['values']), code
for p in site.rglob('*'):
    if p.is_file():
        assert p.suffix not in ['.py','.env','.pem','.key'], f'Non-public file in artifact: {p.name}'
        assert not re.search(r'(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}',p.read_text(encoding='utf8')), 'Credential-like content detected'
print(f'Artifact verified: {len(companies)} dated stock records, no credentials detected.')
