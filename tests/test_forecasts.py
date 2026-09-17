import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'collect_forecasts.py'
NOW = '2026-09-17T10:00:00+00:00'

class ForecastTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('forecasts', PATH)
        cls.m = importlib.util.module_from_spec(spec)
        if PATH.exists(): spec.loader.exec_module(cls.m)

    def payload(self):
        return {'yctj_list': [dict(SECURITY_CODE='688256', YEAR=2025, YEAR_MARK='A', TOTAL_OPERATE_INCOME=6e9),
                              dict(SECURITY_CODE='688256', YEAR=2026, YEAR_MARK='E', TOTAL_OPERATE_INCOME=16e9, OPERATE_PROFIT=None, EPS=9.8, EPS_COUNT=16, TOTAL_OPERATE_INCOME_COUNT=15)],
                'jgyc': [dict(SECURITY_CODE='688256', ORG_CODE='00000000', PUBLISH_DATE='2026-09-17 00:00:00'),
                         dict(SECURITY_CODE='688256', ORG_CODE='123', PUBLISH_DATE='2026-09-02 00:00:00')]}

    def test_units_actual_estimate_counts_and_real_report_date(self):
        result = self.m.normalize('688256', self.payload(), NOW)
        self.assertEqual(result['latestReportDate'], '2026-09-02')
        self.assertEqual(result['years'][0]['kind'], 'actual')
        row = result['years'][1]
        self.assertEqual(row['kind'], 'estimate')
        self.assertEqual(row['revenue'], 16e9)
        self.assertEqual(row['counts']['revenue'], 15)
        self.assertIsNone(row['operatingProfit'])
        self.assertIsNone(row['counts']['operatingProfit'])

    def test_reject_wrong_code_year_and_future_date(self):
        for key, value in [('SECURITY_CODE', '600519'), ('YEAR', 9999), ('YEAR_MARK', '?')]:
            payload = self.payload()
            payload['yctj_list'][0][key] = value
            with self.assertRaises(ValueError): self.m.normalize('688256', payload, NOW)
        payload = self.payload()
        payload['jgyc'][1]['PUBLISH_DATE'] = '2026-09-18'
        with self.assertRaises(ValueError): self.m.normalize('688256', payload, NOW)

    def test_failed_detail_keeps_dates_and_successful_empty_clears(self):
        old = self.m.normalize('688256', self.payload(), NOW)
        cached = self.m.failed_company('688256', old, '2026-09-18T10:00:00+00:00')
        self.assertEqual(cached['collectedAt'], NOW)
        self.assertEqual(cached['latestReportDate'], '2026-09-02')
        self.assertEqual(cached['status'], 'error_cached')
        fresh = self.m.normalize('688256', {'yctj_list': []}, NOW)
        self.assertEqual(fresh['status'], 'unavailable')
        self.assertEqual(fresh['years'], [])

    def test_summary_failure_preserves_snapshot(self):
        previous = {'meta': {'collectedAt': NOW}, 'companies': {'688256': {'collectedAt': NOW}}}
        result = self.m.failed_summary(previous, 'later', 'network')
        self.assertEqual(result['companies'], previous['companies'])
        self.assertEqual(result['meta']['collectedAt'], NOW)
        self.assertEqual(result['meta']['lastAttemptAt'], 'later')
        self.assertTrue(result['meta']['errors'])

    def test_malformed_payload_is_not_successful_empty(self):
        for payload in ({}, {'yctj_list': None}, {'yctj_list': 'bad'}):
            with self.assertRaises(ValueError): self.m.normalize('688256', payload, NOW)

    def test_nulls_nonfinite_and_zero_remain_distinct(self):
        for value in (None, '', '--', True, 'nan', 'inf'):
            self.assertIsNone(self.m.number(value))
        self.assertEqual(self.m.number(0), 0)

    def test_incomplete_coverage_is_failure(self):
        payload = {'success': True, 'result': {'pages': 1, 'count': 2, 'data': [{'SECURITY_CODE':'688256'}]}}
        with patch.object(self.m, 'fetch', return_value=payload):
            with self.assertRaises(ValueError): self.m.coverage()

    def test_removed_coverage_clears_old_estimates(self):
        old = {'companies': {'688256': self.m.normalize('688256', self.payload(), NOW)}}
        with patch.object(self.m, 'coverage', return_value=set()):
            result = self.m.collect(old, ['688256'])
        self.assertEqual(result['companies']['688256']['years'], [])
        self.assertEqual(result['companies']['688256']['status'], 'unavailable')

    def test_real_report_malformed_date_and_other_table_code_are_rejected(self):
        payload = self.payload()
        payload['jgyc'][1]['PUBLISH_DATE'] = '2026-02-30'
        with self.assertRaises(ValueError): self.m.normalize('688256', payload, NOW)
        payload = self.payload()
        payload['jgyc'][1]['SECURITY_CODE'] = '600519'
        with self.assertRaises(ValueError): self.m.normalize('688256', payload, NOW)

if __name__ == '__main__': unittest.main()
