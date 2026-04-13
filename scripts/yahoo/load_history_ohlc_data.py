# pip install supabase yfinance pandas python-dateutil

import os
from pathlib import Path

import pandas as pd
import yfinance as yf
from supabase import create_client
from datetime import datetime
import math

ROOT = Path(__file__).resolve().parents[2]


def load_env():
    """Load .env into process env (dotenv if available, fallback manual)."""
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

# DB CONFIG
SUPABASE_URL = os.environ.get("VITE_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
TABLE = "stock_market_history"
all_rows = []
page = 0
BATCH_SIZE = 1000  # tune by API limits

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

while True:
    from_row = page * BATCH_SIZE
    to_row = (page + 1) * BATCH_SIZE - 1

    print(f"Fetching rows {from_row} -> {to_row} ...")

    data = (
        supabase.table(TABLE)
        .select("id, symbol, record_date")
        .is_("open_value", None)
        .range(from_row, to_row)
        .execute()
        .data
    )

    if not data:
        break

    all_rows.extend(data)
    page += 1

if len(all_rows) == 0:
    print("No rows found.")
    raise SystemExit

df = pd.DataFrame(all_rows)

# Normalize columns
df['symbol'] = df['symbol'].astype(str).str.upper()
df['record_date'] = pd.to_datetime(df['record_date']).dt.normalize()

symbols = df['symbol'].unique()

symbols_filter = os.environ.get("OHLC_SYMBOLS")
if symbols_filter:
    allow = {s.strip().upper() for s in symbols_filter.split(",") if s.strip()}
    symbols = [s for s in symbols if s in allow]

symbols_limit = os.environ.get("OHLC_SYMBOL_LIMIT")
if symbols_limit:
    try:
        limit = max(0, int(symbols_limit))
        if limit:
            symbols = symbols[:limit]
    except ValueError:
        pass

print(f"Total rows loaded: {len(df)}")
print(f"Unique symbols to fetch: {len(symbols)}")

updates = []

# ---- STEP 2: Fetch Yahoo OHLC data per symbol ----
for symbol in symbols:
    symbol_rows = df[df['symbol'] == symbol].copy()

    # Filter only rows having valid dates
    symbol_rows = symbol_rows.dropna(subset=["record_date"])
    if symbol_rows.empty:
        print(f"Skipping {symbol}: no valid record_date")
        continue

    min_date = symbol_rows['record_date'].min()
    max_date = symbol_rows['record_date'].max()

    # If min or max is still NaT, skip
    if pd.isna(min_date) or pd.isna(max_date):
        print(f"Skipping {symbol}: min/max date is NaT")
        continue

    start = (min_date - pd.Timedelta(days=2)).strftime("%Y-%m-%d")
    end = (max_date + pd.Timedelta(days=2)).strftime("%Y-%m-%d")
    print(f"Fetching {symbol} from {start} to {end} ...")

    ticker = yf.Ticker(symbol)
    hist = ticker.history(start=start, end=end, interval="1d")[["Open", "High", "Low", "Close"]]

    if hist.empty:
        print(f"No Yahoo data for {symbol}, skipping...")
        continue

    hist = hist.reset_index()
    hist['Date'] = pd.to_datetime(hist['Date']).dt.tz_localize(None).dt.normalize()
    hist = hist.rename(columns={
        "Open": "open_value",
        "High": "high_value",
        "Low": "low_value",
        "Close": "close_value",
    })

    merged = symbol_rows.merge(
        hist[['Date', 'open_value', 'high_value', 'low_value', 'close_value']],
        left_on='record_date', right_on='Date', how='left'
    )

    for _, r in merged.iterrows():
        if pd.isna(r['open_value']):
            continue

        updates.append({
            "id": r['id'],
            "symbol": r['symbol'],
            "record_date": r['record_date'].strftime("%Y-%m-%d"),
            "open_value": float(r['open_value']),
            "high_value": float(r['high_value']),
            "low_value": float(r['low_value']),
            "close_value": float(r['close_value'])
        })

print(f"\n✅ Prepared {len(updates)} rows for update")

# ---- STEP 3: Upsert in chunks ----
def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]

for chunk in chunks(updates, BATCH_SIZE):
    supabase.table(TABLE).upsert(
        chunk,
        on_conflict="symbol, record_date",
        returning="minimal"
    ).execute()
    print(f"⬆️ Upserted {len(chunk)} rows")

print("\n🎯 Done! ✅")
