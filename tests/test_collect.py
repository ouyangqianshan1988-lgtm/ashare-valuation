import importlib.util
import pathlib
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'collect.py'

class CollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('collect', path)
        cls.m = importlib.util.module_from_spec(spec)
        if path.exists(): spec.loader.exec_module(cls.m)

    def test_parser_exists(self):
        self.assertTrue(hasattr(self.m, 'number'), 'null-safe numeric parser required')

    def test_missing_does_not_become_zero(self):
        f = getattr(self.m, 'number', lambda x: 0)
        for value in (None, '', '-', 'NaN', float('inf')):
            self.assertIsNone(f(value))
        self.assertEqual(f(0), 0)

    def test_incomplete_sum_stays_missing(self):
        f = getattr(self.m, 'strict_sum', lambda *xs: 0)
        self.assertIsNone(f(4, None))
        self.assertEqual(f(4, 0), 4)

    def test_latest_visible_row_excludes_future_disclosure(self):
        rows = [dict(SECURITY_CODE='600000', REPORT_DATE='2025-12-31', NOTICE_DATE='2026-10-01'),
                dict(SECURITY_CODE='600000', REPORT_DATE='2024-12-31', NOTICE_DATE='2025-04-01')]
        result = getattr(self.m, 'latest_visible', lambda r,d: {})(rows, '2026-09-17')
        self.assertEqual(result.get('600000', {}).get('REPORT_DATE'), '2024-12-31')

    def test_failed_refresh_keeps_old_timestamp(self):
        old = {'600000': {'code': '600000', 'quoteDate': '2026-09-16', 'price': 10}}
        result = getattr(self.m, 'merge_quotes', lambda a,b: {})(old, {})
        self.assertEqual(result.get('600000', {}).get('quoteDate'), '2026-09-16')

    def test_provider_rejects_failed_payload(self):
        f = getattr(self.m, 'rows_from_payload', lambda d: [])
        with self.assertRaises(ValueError): f({'success': False, 'message':'unavailable'})

    def test_pharmaceutical_is_not_commodity_chemical(self):
        self.assertEqual(self.m.route('化学制药', '恒瑞医药', '通用'), 'fcff')

    def test_financial_routing(self):
        self.assertEqual(self.m.route('银行Ⅱ', '招商银行', '银行'), 'financial')

    def test_total_outage_preserves_last_collection_time(self):
        f = getattr(self.m, 'build_health', lambda previous,stamp,year,total,quotes,tables,errors: {'collectedAt':stamp})
        h = f({'collectedAt':'2026-09-16T10:00:00Z'},'2026-09-17T10:00:00Z',2025,100,{}, {'income':{}}, ['income: timeout'])
        self.assertEqual(h['collectedAt'],'2026-09-16T10:00:00Z')
        self.assertEqual(h['lastAttemptAt'],'2026-09-17T10:00:00Z')
        self.assertEqual(h['providerStatus'],'failed')

    def test_empty_quote_response_is_reported_as_failure(self):
        with patch.object(self.m, 'request', return_value='v_pv_none_match="1";'):
            rows, errors = self.m.fetch_quotes(['600519'])
        self.assertEqual(rows,{})
        self.assertTrue(errors)

    def test_quote_only_refresh_updates_share_bridge_and_source_date(self):
        old={'600000':{'code':'600000','quoteDate':'2026-09-16','financials':{'shares':100},'sources':[{'name':'腾讯财经 · 行情','date':'2026-09-16'}],'missing':[]}}
        new={'600000':{'quoteDate':'2026-09-17','shares':200,'price':5}}
        merged=self.m.merge_quotes(old,new)['600000']
        self.assertEqual(merged['financials']['shares'],200)
        self.assertEqual(merged['sources'][0]['date'],'2026-09-17')
        self.assertEqual(old['600000']['financials']['shares'],100)

if __name__ == '__main__': unittest.main()
