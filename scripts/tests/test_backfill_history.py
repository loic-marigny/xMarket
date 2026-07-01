import unittest

from scripts.backfill_history import build_records_for_symbol, detect_missing_ranges


class BackfillHistoryTests(unittest.TestCase):
    def test_detect_missing_ranges_returns_consecutive_gaps(self) -> None:
        existing = {
            "2026-06-12": {"open_value": 1.0, "high_value": 1.0, "low_value": 1.0, "close_value": 1.0},
            "2026-06-15": {"open_value": 1.0, "high_value": 1.0, "low_value": 1.0, "close_value": 1.0},
            "2026-06-16": {"open_value": 1.0, "high_value": 1.0, "low_value": 1.0, "close_value": 1.0},
        }
        missing = detect_missing_ranges(existing, "2026-06-12", "2026-06-16")
        self.assertEqual(missing, [("2026-06-13", "2026-06-14")])

    def test_build_records_for_symbol_only_returns_missing_or_incomplete_rows(self) -> None:
        hist_df = [
            {"Date": "2026-06-12", "Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5},
            {"Date": "2026-06-13", "Open": 1.2, "High": 2.2, "Low": 0.6, "Close": 1.7},
            {"Date": "2026-06-14", "Open": 1.3, "High": 2.3, "Low": 0.7, "Close": 1.8},
        ]

        import pandas as pd

        hist = pd.DataFrame(hist_df)
        existing = {
            "2026-06-12": {
                "open_value": 1.0,
                "high_value": 2.0,
                "low_value": 0.5,
                "close_value": 1.5,
            },
            "2026-06-13": {
                "open_value": None,
                "high_value": None,
                "low_value": None,
                "close_value": None,
            },
        }

        records = build_records_for_symbol("AAPL", hist, existing)
        self.assertEqual([record["record_date"] for record in records], ["2026-06-13", "2026-06-14"])


if __name__ == "__main__":
    unittest.main()
