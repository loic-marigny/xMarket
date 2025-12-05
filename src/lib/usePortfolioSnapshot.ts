import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, query, type DocumentReference } from "firebase/firestore";
import { db } from "../firebase";
import provider from "./prices";
import { computeCash, computePositions, type Order, type Position } from "./portfolio";

export interface PortfolioSnapshot {
  orders: Order[];
  positions: Record<string, Position>;
  prices: Record<string, number>;
  cash: number;
  marketValue: number;
  totalValue: number;
  initialCredits: number;
  loadingPrices: boolean;
  loadingInitial: boolean;
}

const DEFAULT_INITIAL = 1_000_000;
const EPSILON = 1e-9;

function normalizePrice(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
}


/** Hit the slower candle endpoint when the quote endpoint does not have a value. */
async function fetchFallbackClose(symbol: string): Promise<number | undefined> {
  try {
    const hist = await provider.getDailyHistory(symbol);
    const last = hist.at(-1)?.close;
    return normalizePrice(last);
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to a user's orders and lazily hydrate derived data (positions, prices, totals).
 * The hook intentionally separates Firestore latency (orders + initial credits) from price fetches.
 */
export function usePortfolioSnapshot(uid: string | null | undefined): PortfolioSnapshot {
  const [orders, setOrders] = useState<Order[]>([]);
  const [initialCredits, setInitialCredits] = useState<number>(DEFAULT_INITIAL);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loadingPrices, setLoadingPrices] = useState<boolean>(false);
  const [loadingInitial, setLoadingInitial] = useState<boolean>(true);

  useEffect(() => {
    if (!uid) {
      setOrders([]);
      return;
    }
    const qRef = query(collection(db, "users", uid, "orders"), orderBy("ts", "asc"));
    return onSnapshot(qRef, snap => {
      const arr: Order[] = snap.docs.map(d => d.data() as Order);
      setOrders(arr);
    });
  }, [uid]);

  useEffect(() => {
    let cancelled = false;
    if (!uid) {
      setInitialCredits(DEFAULT_INITIAL);
      setLoadingInitial(false);
      return;
    }
    setLoadingInitial(true);
    (async () => {
      try {
        const ref: DocumentReference = doc(db, "users", uid);
        const snap = await getDoc(ref);
        if (cancelled) return;
        const raw = snap.exists() ? (snap.data() as any)?.initialCredits : undefined;
        const next = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_INITIAL;
        setInitialCredits(next);
      } catch {
        if (!cancelled) setInitialCredits(DEFAULT_INITIAL);
      } finally {
        if (!cancelled) setLoadingInitial(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const positions = useMemo(() => computePositions(orders), [orders]);
  const cash = useMemo(() => computeCash(initialCredits, orders), [initialCredits, orders]);

  const heldSymbols = useMemo(() => {
    return Object.entries(positions)
      .filter(([, p]) => Math.abs(p.qty) > EPSILON)
      .map(([sym]) => sym)
      .sort();
  }, [positions]);
  const heldKey = heldSymbols.join("|");

  // Fetch last prices (and fall back to candle closes) in parallel for every held symbol.
  useEffect(() => {
    let cancelled = false;
    if (!heldSymbols.length) {
      setPrices({});
      setLoadingPrices(false);
      return () => {
        cancelled = true;
      };
    }
    setLoadingPrices(true);

    const fetchSymbolPrice = async (symbol: string): Promise<number | undefined> => {
      try {
        const px = await provider.getLastPrice(symbol);
        const normalized = normalizePrice(px);
        if (typeof normalized === "number") return normalized;
      } catch {
        // fall through to the slow path
      }
      return fetchFallbackClose(symbol);
    };

    (async () => {
      try {
        const entries = await Promise.all(
          heldSymbols.map(async (symbol) => {
            const price = await fetchSymbolPrice(symbol);
            return { symbol, price };
          }),
        );

        if (cancelled) return;
        const fetchedMap = entries.reduce<Record<string, number>>((acc, entry) => {
          if (typeof entry.price === "number") {
            acc[entry.symbol] = entry.price;
          }
          return acc;
        }, {});

        setPrices((prev) => {
          const next: Record<string, number> = {};
          for (const symbol of heldSymbols) {
            if (symbol in fetchedMap) {
              next[symbol] = fetchedMap[symbol];
            } else if (symbol in prev) {
              next[symbol] = prev[symbol];
            } else {
              next[symbol] = 0;
            }
          }
          return next;
        });
      } catch (error) {
        console.error("Failed to load portfolio prices", error);
      } finally {
        if (!cancelled) {
          setLoadingPrices(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [heldKey]);

  const marketValue = useMemo(() => {
    let total = 0;
    for (const [sym, pos] of Object.entries(positions)) {
      const qty = pos.qty;
      if (Math.abs(qty) <= EPSILON) continue;
      const px = prices[sym];
      if (typeof px === "number" && Number.isFinite(px)) {
        total += qty * px;
      }
    }
    return total;
  }, [positions, prices]);

  const totalValue = cash + marketValue;

  return {
    orders,
    positions,
    prices,
    cash,
    marketValue,
    totalValue,
    initialCredits,
    loadingPrices,
    loadingInitial,
  };
}
