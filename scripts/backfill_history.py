#!/usr/bin/env python3
"""Backfill missing OHLC history rows in Supabase for a date range.

This is intended for repairing gaps caused by temporary outages or failed syncs.
It uses yfinance to fetch daily OHLC data for the requested range and upserts
only the missing or incomplete rows into the stock_market_history table.
"""

from __future__ import annotations

import argparse
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
import yfinance as yf
from supabase import create_client

ROOT = Path(__file__).resolve().parents[1]


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return

    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(env_path)
        return
    except Exception:
        pass

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env()

SUPABASE_URL = os.environ.get("VITE_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
TABLE_COMPANIES = "stock_market_companies"
TABLE_HISTORY = "stock_market_history"
BATCH_SIZE = 1000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill missing stock history rows in Supabase")
    parser.add_argument("--symbols", default="", help="Comma-separated symbols to backfill")
    parser.add_argument("--from-date", help="Start date YYYY-MM-DD (defaults to the earliest missing gap)")
    parser.add_argument("--to-date", help="End date YYYY-MM-DD (defaults to today)")
    parser.add_argument("--limit", type=int, default=0, help="Max number of symbols to process")
    parser.add_argument("--dry-run", action="store_true", help="Print the rows that would be inserted without writing")
    return parser.parse_args()


def normalize_symbol(symbol: str) -> str:
    return symbol.strip().upper()


def normalize_date(value: str | date | datetime) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return pd.to_datetime(value).normalize().date().isoformat()


def get_supabase_client():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def get_symbols(supabase, requested_symbols: str, limit: int) -> list[str]:
    if requested_symbols:
        symbols = [normalize_symbol(symbol) for symbol in requested_symbols.split(",") if symbol.strip()]
        return symbols[:limit] if limit > 0 else symbols

    response = supabase.table(TABLE_COMPANIES).select("symbol").execute()
    symbols = [normalize_symbol(item["symbol"]) for item in response.data if item.get("symbol")]
    return sorted(set(symbols[:limit] if limit > 0 else symbols))


def fetch_existing_rows(supabase, symbols: list[str], start_date: str, end_date: str) -> dict[str, dict[str, dict[str, Any]]]:
    if not symbols:
        return {}

    response = (
        supabase.table(TABLE_HISTORY)
        .select("symbol, record_date, open_value, high_value, low_value, close_value, record_value")
        .in_("symbol", symbols)
        .gte("record_date", start_date)
        .lte("record_date", end_date)
        .execute()
    )

    rows_by_symbol: dict[str, dict[str, dict[str, Any]]] = {}
    for row in response.data or []:
        symbol = normalize_symbol(str(row.get("symbol") or ""))
        if not symbol:
            continue
        date_key = normalize_date(row.get("record_date", ""))
        rows_by_symbol.setdefault(symbol, {})[date_key] = row
    return rows_by_symbol


def is_row_complete(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    return all(
        pd.notna(row.get(column))
        for column in ("open_value", "high_value", "low_value", "close_value")
    )


def detect_missing_ranges(existing_rows: dict[str, Any], start_date: str, end_date: str) -> list[tuple[str, str]]:
    start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
    end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()

    missing_ranges: list[tuple[str, str]] = []
    current = start_dt

    while current <= end_dt:
        row = existing_rows.get(current.isoformat())
        if not is_row_complete(row):
            gap_start = current
            while current <= end_dt and not is_row_complete(existing_rows.get(current.isoformat())):
                current += timedelta(days=1)
            missing_ranges.append((gap_start.isoformat(), (current - timedelta(days=1)).isoformat()))
        else:
            current += timedelta(days=1)

    return missing_ranges


def fetch_symbol_history(symbol: str, start_date: str, end_date: str) -> pd.DataFrame:
    start_dt = pd.Timestamp(start_date).normalize()
    end_dt = pd.Timestamp(end_date).normalize() + pd.Timedelta(days=1)

    ticker = yf.Ticker(symbol)
    hist = ticker.history(start=start_date, end=end_dt.strftime("%Y-%m-%d"), interval="1d", auto_adjust=False)
    if hist.empty:
        return pd.DataFrame(columns=["Date", "Open", "High", "Low", "Close"])

    hist = hist[["Open", "High", "Low", "Close"]].dropna(how="all")
    if hist.empty:
        return pd.DataFrame(columns=["Date", "Open", "High", "Low", "Close"])

    hist = hist.reset_index()
    hist["Date"] = pd.to_datetime(hist["Date"]).dt.tz_localize(None).dt.normalize()
    hist = hist[(hist["Date"] >= start_dt) & (hist["Date"] <= end_dt)]
    return hist


def build_records_for_symbol(symbol: str, hist_df: pd.DataFrame, existing_rows: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for _, row in hist_df.iterrows():
        date_key = normalize_date(row["Date"])
        existing = existing_rows.get(date_key)
        if existing and pd.notna(existing.get("open_value")) and pd.notna(existing.get("high_value")) and pd.notna(existing.get("low_value")) and pd.notna(existing.get("close_value")):
            continue

        payload = {
            "symbol": symbol,
            "record_date": date_key,
            "open_value": round(float(row["Open"]), 2),
            "high_value": round(float(row["High"]), 2),
            "low_value": round(float(row["Low"]), 2),
            "close_value": round(float(row["Close"]), 2),
            "record_value": round(float(row["Close"]), 2),
        }
        records.append(payload)
    return records


def upsert_records(supabase, records: list[dict[str, Any]]) -> int:
    if not records:
        return 0

    for offset in range(0, len(records), BATCH_SIZE):
        batch = records[offset : offset + BATCH_SIZE]
        supabase.table(TABLE_HISTORY).upsert(batch, on_conflict="symbol, record_date").execute()
    return len(records)


def main() -> int:
    args = parse_args()
    end_date = normalize_date(args.to_date or date.today().isoformat())
    start_date = normalize_date(args.from_date or (date.today() - timedelta(days=365)).isoformat())
    if start_date > end_date:
        raise SystemExit("--from-date must be before or equal to --to-date")

    supabase = get_supabase_client()
    symbols = get_symbols(supabase, args.symbols, args.limit)
    if not symbols:
        print("No symbols to process.")
        return 0

    existing_rows = fetch_existing_rows(supabase, symbols, start_date, end_date)
    total_records = 0

    for symbol in symbols:
        symbol_rows = existing_rows.get(symbol, {})
        missing_ranges = detect_missing_ranges(symbol_rows, start_date, end_date)
        if not missing_ranges:
            print(f"[skip] {symbol}: already complete for {start_date} -> {end_date}")
            continue

        print(f"[gap] {symbol}: {len(missing_ranges)} missing range(s) detected")
        for gap_start, gap_end in missing_ranges:
            hist_df = fetch_symbol_history(symbol, gap_start, gap_end)
            if hist_df.empty:
                print(f"[skip] {symbol}: no history returned for {gap_start} -> {gap_end}")
                continue

            records = build_records_for_symbol(symbol, hist_df, symbol_rows)
            if not records:
                continue

            if args.dry_run:
                print(f"[dry-run] {symbol}: {len(records)} rows would be upserted for {gap_start} -> {gap_end}")
            else:
                count = upsert_records(supabase, records)
                print(f"[ok] {symbol}: upserted {count} rows for {gap_start} -> {gap_end}")
            total_records += len(records)

    print(f"Completed. Total rows affected: {total_records}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
