import json
import os
from pathlib import Path

from supabase import create_client

ROOT = Path(__file__).resolve().parents[1]


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

SUPABASE_URL = os.environ.get("VITE_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

COMPANIES_TABLE = "stock_market_companies"
HISTORY_TABLE = "stock_market_history"

COMPANIES_INDEX = ROOT / "public" / "companies" / "index.json"
HISTORY_DIR = ROOT / "public" / "history"

BATCH_SIZE = 1000

MARKET_MAP = {
    "US": "New York",
    "CN": "Shanghai",
    "EU": "Euronext",
    "JP": "Tokyo",
    "SA": "Saudi Arabia",
    "CRYPTO": "Crypto",
    "FX": "Forex",
    "FOREX": "Forex",
    "COM": "Commodities",
    "IDX": "Indices",
}


def map_market(code: str | None) -> str | None:
    if not code:
        return None
    return MARKET_MAP.get(code.upper(), code.upper())


def get_supabase():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def chunks(lst, size):
    for i in range(0, len(lst), size):
        yield lst[i : i + size]


def load_companies(supabase):
    if not COMPANIES_INDEX.exists():
        raise FileNotFoundError(f"Missing {COMPANIES_INDEX}")

    companies = json.loads(COMPANIES_INDEX.read_text(encoding="utf-8"))
    payload = []

    for c in companies:
        market_code = c.get("market")
        payload.append(
            {
                "symbol": c.get("symbol"),
                "name": c.get("name"),
                "sector": c.get("sector"),
                "market_code": market_code,
                "market": map_market(market_code),
                "profile": c.get("profile"),
                "logo": c.get("logo"),
                "history": c.get("history"),
            }
        )

    for batch in chunks(payload, BATCH_SIZE):
        supabase.table(COMPANIES_TABLE).upsert(
            batch,
            on_conflict="symbol",
        ).execute()

    print(f"Inserted/updated {len(payload)} companies.")


def load_history(supabase):
    if not HISTORY_DIR.exists():
        raise FileNotFoundError(f"Missing {HISTORY_DIR}")

    total = 0
    batch = []

    for file_path in sorted(HISTORY_DIR.glob("*.json")):
        symbol = file_path.stem
        try:
            rows = json.loads(file_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"Skipping invalid JSON: {file_path.name}")
            continue

        for row in rows:
            date = row.get("date")
            close = row.get("close")
            if not date or close is None:
                continue

            record = {
                "symbol": symbol,
                "record_date": date,
                "record_value": float(close),
                "close_value": float(close),
            }
            batch.append(record)
            total += 1

            if len(batch) >= BATCH_SIZE:
                supabase.table(HISTORY_TABLE).upsert(
                    batch,
                    on_conflict="symbol, record_date",
                ).execute()
                print(f"Uploaded {len(batch)} history rows...")
                batch = []

    if batch:
        supabase.table(HISTORY_TABLE).upsert(
            batch,
            on_conflict="symbol, record_date",
        ).execute()
        print(f"Uploaded {len(batch)} history rows...")

    print(f"Inserted/updated {total} history rows.")


def main():
    supabase = get_supabase()
    load_companies(supabase)
    load_history(supabase)


if __name__ == "__main__":
    main()
