import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { auth, db } from "../firebase";
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import provider from "../lib/prices";
import {
  fetchCompaniesIndex,
  type Company,
  marketLabel,
} from "../lib/companies";
import { usePortfolioSnapshot } from "../lib/usePortfolioSnapshot";
import { submitSpotOrder } from "../lib/trading";
import {
  ORDER_SNAPSHOT_RETENTION_MS,
  recordWealthSnapshot,
} from "../lib/wealthHistory";
import CompanySidebar from "../components/CompanySidebar";
import LogoBadge from "../components/LogoBadge";
import { useI18n } from "../i18n/I18nProvider";
import PositionsTable from "../components/PositionsTable";
import {
  buildOpenLots,
  buildPositionRows,
  formatCompactValue,
  type PositionRow,
} from "../lib/positionsTable";
import { useConditionalOrders } from "../lib/useConditionalOrders";
import {
  cancelConditionalOrder,
  executeConditionalOrder,
  scheduleConditionalOrder,
  type ConditionalOrder,
  type TriggerType,
} from "../lib/conditionalOrders";
import "./Trade.css";
import { useLogoAppearance } from "../hooks/useLogoAppearance";

type EntryMode = "qty" | "amount";

/** Resolve relative asset paths against BASE_URL so logos work everywhere. */
const assetPath = (path: string) => {
  if (/^https?:/i.test(path)) return path;
  const base =
    ((import.meta as any).env?.BASE_URL as string | undefined) ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const trimmed = path.replace(/^\/+/, "");
  return `${normalizedBase}${trimmed}`;
};

/** Trade page with hero entry, conditional scheduler, and open positions. */
export default function Trade() {
  const { t, locale } = useI18n();
  const uid = auth.currentUser!.uid;

  const [symbol, setSymbol] = useState<string>("AAPL");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [mode, setMode] = useState<EntryMode>("qty");
  const [qty, setQty] = useState<number>(1);
  const [amount, setAmount] = useState<number>(0);
  const [last, setLast] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [conditionalSide, setConditionalSide] = useState<"buy" | "sell">(
    "sell",
  );
  const [conditionalQty, setConditionalQty] = useState<number>(0);
  const [conditionalTriggerPrice, setConditionalTriggerPrice] =
    useState<number>(0);
  const [conditionalTriggerType, setConditionalTriggerType] =
    useState<TriggerType>("gte");
  const [conditionalMsg, setConditionalMsg] = useState<string>("");
  const [conditionalLoading, setConditionalLoading] = useState<boolean>(false);
  const [conditionalMode, setConditionalMode] = useState<EntryMode>("qty");
  const [conditionalAmount, setConditionalAmount] = useState<number>(0);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [focusSidebarOnOpen, setFocusSidebarOnOpen] = useState<boolean>(false);
  const reopenButtonRef = useRef<HTMLButtonElement | null>(null);

  const { positions, cash, orders, prices, loadingPrices } =
    usePortfolioSnapshot(uid);
  const openLots = useMemo(() => buildOpenLots(orders), [orders]);
  const portfolioRows = useMemo(
    () => buildPositionRows(openLots, prices),
    [openLots, prices],
  );
  const posQty = positions[symbol]?.qty ?? 0;
  const conditionalOrders = useConditionalOrders(uid);
  const pendingConditionalOrders = useMemo(
    () => conditionalOrders.filter((order) => order.status === "pending"),
    [conditionalOrders],
  );
  const fmtValue = formatCompactValue;

  // Detect whether the symbol represents an FX pair (index lookup or 6-letter heuristic)
  const isFxSymbol = (sym: string) =>
    /^[A-Z]{6}$/.test(sym) ||
    companies.find((c) => c.symbol === sym)?.market?.toUpperCase() === "FX";

  // USDJPY -> { base: "USD", quote: "JPY" }
  const parseFx = (sym: string) => {
    const s = sym.toUpperCase().replace(/[^A-Z]/g, "");
    return { base: s.slice(0, 3), quote: s.slice(3, 6) };
  };

  useEffect(() => {
    (async () => {
      try {
        const idx = await fetchCompaniesIndex();
        setCompanies(idx);
        if (!idx.find((c) => c.symbol === symbol)) {
          const firstUS = idx.find(
            (c) => (c.market || "").toUpperCase() === "US",
          );
          setSymbol(firstUS?.symbol || idx[0]?.symbol || symbol);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const fetched = await provider.getLastPrice(symbol);
      setLast(Number.isFinite(fetched) && fetched > 0 ? fetched : 0);
    })();
  }, [symbol]);

  useEffect(() => {
    if (conditionalTriggerPrice <= 0 && last > 0) {
      setConditionalTriggerPrice(last);
    }
  }, [last, conditionalTriggerPrice]);

  useEffect(() => {
    setConditionalQty((current) => {
      if (current > 0) return current;
      if (conditionalSide === "sell") {
        return posQty > 0 ? posQty : 1;
      }
      return 1;
    });
  }, [conditionalSide, posQty]);

  useEffect(() => {
    if (!sidebarOpen) {
      const frame = requestAnimationFrame(() => {
        reopenButtonRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [sidebarOpen]);

  useEffect(() => {
    if (!uid || pendingConditionalOrders.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled) return;
      const grouped = new Map<string, ConditionalOrder[]>();
      for (const order of pendingConditionalOrders) {
        if (!grouped.has(order.symbol)) grouped.set(order.symbol, []);
        grouped.get(order.symbol)!.push(order);
      }
      for (const [sym, list] of grouped.entries()) {
        try {
          const px = await provider.getLastPrice(sym);
          if (!Number.isFinite(px) || px <= 0) continue;
          for (const order of list) {
            if (shouldTrigger(order, px)) {
              executeConditionalOrder({ uid, order, fillPrice: px }).catch(
                (error) => {
                  console.error("Failed to execute conditional order", error);
                },
              );
            }
          }
        } catch (error) {
          console.error("Conditional order polling error", error);
        }
      }
      if (!cancelled) {
        timer = setTimeout(poll, 15_000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [uid, pendingConditionalOrders]);

  const openSidebar = useCallback(() => {
    if (!sidebarOpen) {
      setSidebarOpen(true);
      setFocusSidebarOnOpen(true);
    }
  }, [sidebarOpen]);

  const closeSidebar = useCallback(() => {
    setFocusSidebarOnOpen(false);
    setSidebarOpen(false);
  }, []);

  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const previewQty =
    mode === "qty"
      ? Math.max(0, Number.isFinite(qty) ? qty : 0)
      : last
        ? round6((amount || 0) / last)
        : 0;
  const scheduledQtyPreview = useMemo(() => {
    if (conditionalMode === "qty")
      return Math.max(0, Number.isFinite(conditionalQty) ? conditionalQty : 0);
    if (
      !Number.isFinite(conditionalTriggerPrice) ||
      conditionalTriggerPrice <= 0
    )
      return 0;
    return round6(
      (Number.isFinite(conditionalAmount) ? conditionalAmount : 0) /
        conditionalTriggerPrice,
    );
  }, [
    conditionalMode,
    conditionalQty,
    conditionalAmount,
    conditionalTriggerPrice,
  ]);

  const validate = (side: "buy" | "sell", px: number) => {
    if (!Number.isFinite(px) || px <= 0) {
      return t("trade.validation.invalidPrice");
    }
    const q =
      mode === "qty" ? (Number.isFinite(qty) ? qty : 0) : round6(amount / px);
    if (!q || q <= 0) return t("trade.validation.invalidQuantity");
    if (side === "sell" && posQty < q - 1e-9)
      return t("trade.validation.insufficientPosition");
    if (side === "buy") {
      const needed = q * px;
      if (cash + 1e-6 < needed) return t("trade.validation.insufficientCash");
    }
    return "";
  };

  const place = async (side: "buy" | "sell") => {
    setMsg("");
    setLoading(true);
    try {
      const fetchedPrice = await provider.getLastPrice(symbol);
      if (!Number.isFinite(fetchedPrice) || fetchedPrice <= 0) {
        setMsg(t("trade.validation.invalidPrice"));
        setLoading(false);
        return;
      }
      const fillPrice = fetchedPrice;

      // Base quantity computed from the selected entry mode
      const qBase =
        mode === "qty"
          ? Number.isFinite(qty)
            ? Number(qty)
            : 0
          : round6((Number.isFinite(amount) ? Number(amount) : 0) / fillPrice);
      if (qBase <= 0) {
        setMsg(t("trade.validation.invalidQuantity"));
        setLoading(false);
        return;
      }

      if (isFxSymbol(symbol)) {
        const { base, quote } = parseFx(symbol);
        // ex. buy USDJPY: +USD(qBase)  -JPY(qBase*fillPrice)
        const deltaBase = side === "buy" ? qBase : -qBase;
        const deltaQuote =
          side === "buy" ? -qBase * fillPrice : qBase * fillPrice;

        // Optional: add a sufficiency check on the quote balance if needed
        const baseRef = doc(db, "users", uid, "balances", base);
        const quoteRef = doc(db, "users", uid, "balances", quote);
        const ordRef = doc(collection(db, "users", uid, "orders"));

        await runTransaction(db, async (tx) => {
          const baseSnap = await tx.get(baseRef);
          const quoteSnap = await tx.get(quoteRef);
          const baseAmt =
            (baseSnap.exists() ? (baseSnap.data() as any).amount : 0) +
            deltaBase;
          const quoteAmt =
            (quoteSnap.exists() ? (quoteSnap.data() as any).amount : 0) +
            deltaQuote;

          tx.set(baseRef, { amount: baseAmt });
          tx.set(quoteRef, { amount: quoteAmt });

          tx.set(ordRef, {
            symbol,
            side,
            qty: qBase,
            fillPrice,
            ts: serverTimestamp(),
            type: "FX",
            base,
            quote,
          });
        });

        recordWealthSnapshot(uid, {
          source: "fx-trade",
          snapshotType: "order",
          retentionMs: ORDER_SNAPSHOT_RETENTION_MS,
        }).catch((error) => {
          console.error("Failed to record wealth snapshot", error);
        });

        setMsg(
          side === "buy" ? t("trade.success.buy") : t("trade.success.sell"),
        );
        if (mode === "qty") setQty(1);
        else setAmount(0);
        setLast(fillPrice);
        return;
      }

      // --- Non-FX path: stocks/ETFs/crypto settle into positions ---
      const err = validate(side, fillPrice);
      if (err) {
        setMsg(err);
        setLoading(false);
        return;
      }

      await submitSpotOrder({
        uid,
        symbol,
        side,
        qty: qBase,
        fillPrice,
        extra: { source: "Trade" },
      });

      setMsg(side === "buy" ? t("trade.success.buy") : t("trade.success.sell"));
      if (mode === "qty") setQty(1);
      else setAmount(0);
      setLast(fillPrice);
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const placeholderLogoPath = assetPath("img/logo-placeholder.svg");
  const selectedCompany =
    companies.find((company) => company.symbol === symbol) ?? null;
  const companyLogo = selectedCompany?.logo
    ? assetPath(selectedCompany.logo)
    : placeholderLogoPath;
  const logoStyle = useLogoAppearance(companyLogo, "hero");

  const companyPrimaryName =
    (selectedCompany as any)?.displayName ??
    selectedCompany?.name ??
    selectedCompany?.symbol ??
    symbol;
  const longNameSuffix =
    selectedCompany?.name && selectedCompany.name !== companyPrimaryName
      ? selectedCompany.name
      : undefined;
  const companySubtitleText = useMemo(() => {
    const details: string[] = [];
    if (selectedCompany?.sector) details.push(selectedCompany.sector);
    if (selectedCompany?.market)
      details.push(marketLabel(selectedCompany.market));
    const descriptor = details.join(" \u00b7 ");
    const ticker = selectedCompany?.symbol ?? symbol;
    if (descriptor) return `${ticker} - ${descriptor}`;
    return ticker;
  }, [selectedCompany, symbol]);

  const handleSelectSymbol = useCallback(
    (value: string) => {
      setSymbol(value);
      if (!sidebarOpen) {
        setSidebarOpen(true);
        setFocusSidebarOnOpen(true);
      }
    },
    [sidebarOpen],
  );

  const sortedConditionalOrders = useMemo(() => {
    return [...conditionalOrders].sort((a, b) => {
      const priority = (status: ConditionalOrder["status"]) => {
        switch (status) {
          case "pending":
            return 0;
          case "executing":
            return 1;
          case "error":
            return 2;
          case "triggered":
            return 3;
          case "cancelled":
          default:
            return 4;
        }
      };
      const diff = priority(a.status) - priority(b.status);
      if (diff !== 0) return diff;
      const aTime = a.createdAt?.getTime() ?? 0;
      const bTime = b.createdAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }, [conditionalOrders]);

  const companyBySymbol = useMemo(
    () => new Map(companies.map((company) => [company.symbol, company])),
    [companies],
  );

  const statusLabel = (status: ConditionalOrder["status"]) => {
    switch (status) {
      case "pending":
        return t("trade.schedule.status.pending");
      case "executing":
        return t("trade.schedule.status.executing");
      case "triggered":
        return t("trade.schedule.status.triggered");
      case "cancelled":
        return t("trade.schedule.status.cancelled");
      case "error":
        return t("trade.schedule.status.error");
      default:
        return status;
    }
  };

  const statusBadgeTone = (status: ConditionalOrder["status"]) => {
    switch (status) {
      case "pending":
      case "executing":
        return "waiting";
      case "triggered":
        return "success";
      case "error":
        return "danger";
      case "cancelled":
        return "muted";
      default:
        return "muted";
    }
  };

  const canCancel = (status: ConditionalOrder["status"]) =>
    status === "pending" || status === "executing" || status === "error";

  const handlePrefillSell = useCallback((row: PositionRow) => {
    setSymbol(row.symbol);
    setMode("qty");
    setQty(row.qty);
    setConditionalSide("sell");
    setConditionalQty(row.qty);
    setConditionalTriggerType("gte");
    const fallbackPrice = row.last > 0 ? row.last : row.buyPrice;
    if (fallbackPrice > 0) {
      setConditionalTriggerPrice(fallbackPrice);
    }
  }, []);

  const handleScheduleConditional = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (conditionalLoading) return;
    setConditionalMsg("");
    if (
      !Number.isFinite(conditionalTriggerPrice) ||
      conditionalTriggerPrice <= 0
    ) {
      setConditionalMsg(t("trade.schedule.validation.triggerPrice"));
      return;
    }
    if (!scheduledQtyPreview || scheduledQtyPreview <= 0) {
      setConditionalMsg(t("trade.schedule.validation.qty"));
      return;
    }
    if (conditionalSide === "sell" && scheduledQtyPreview > posQty + 1e-9) {
      setConditionalMsg(t("trade.schedule.validation.position"));
      return;
    }
    if (conditionalSide === "buy") {
      const needed = scheduledQtyPreview * conditionalTriggerPrice;
      if (cash + 1e-6 < needed) {
        setConditionalMsg(t("trade.schedule.validation.cash"));
        return;
      }
    }

    try {
      setConditionalLoading(true);
      await scheduleConditionalOrder({
        uid,
        symbol,
        side: conditionalSide,
        qty: scheduledQtyPreview,
        triggerPrice: conditionalTriggerPrice,
        triggerType: conditionalTriggerType,
      });
      setConditionalMsg(t("trade.schedule.success"));
      if (conditionalMode === "qty") setConditionalQty(0);
      else setConditionalAmount(0);
    } catch (error: any) {
      setConditionalMsg(error?.message ?? String(error));
    } finally {
      setConditionalLoading(false);
    }
  };

  const handleCancelConditional = async (orderId: string) => {
    try {
      await cancelConditionalOrder(uid, orderId);
    } catch (error: any) {
      setConditionalMsg(error?.message ?? String(error));
    }
  };

  return (
    <main className="explore-page">
      <div
        className={`explore-layout${sidebarOpen ? "" : " sidebar-collapsed"}`}
      >
        <CompanySidebar
          companies={companies}
          selectedSymbol={symbol}
          onSelectSymbol={handleSelectSymbol}
          collapsed={!sidebarOpen}
          onCollapse={closeSidebar}
          onExpand={openSidebar}
          title={t("explore.markets")}
          searchPlaceholder={t("explore.searchPlaceholder")}
          noResultsLabel={t("explore.noResults")}
          hideLabel={t("explore.hideSidebar")}
          assetPath={assetPath}
          placeholderLogoPath={placeholderLogoPath}
          marketLabel={marketLabel}
          focusOnMount={focusSidebarOnOpen}
          onFocusHandled={() => setFocusSidebarOnOpen(false)}
        />

        <div className="explore-main">
          {!sidebarOpen && (
            <button
              type="button"
              ref={reopenButtonRef}
              className="explore-sidebar-toggle reopen"
              onClick={openSidebar}
              aria-label={t("explore.showSidebar")}
              title={t("explore.showSidebar")}
            >
              <span className="explore-toggle-icon" aria-hidden="true" />
            </button>
          )}

          <div className="explore-main-content trade-content">
            <div className="trade-content-shell">
              <div className="trade-sections">
                <header className="trade-page-header">
                  <div className="portfolio-title-card trade-title-card">
                    <h1>{t("trade.title")}</h1>
                  </div>
                </header>

                <section className="table-card trade-hero-card">
                  <div className="trade-hero-top">
                    <div className="trade-company-identity">
                      <img
                        src={companyLogo}
                        alt={`${companyPrimaryName} logo`}
                        className="trade-company-logo"
                        style={logoStyle}
                      />
                      <div className="trade-company-info">
                        <h1>
                          {companyPrimaryName}
                          {longNameSuffix && (
                            <span className="trade-company-alias">
                              <span
                                aria-hidden="true"
                                className="trade-company-alias-separator"
                              >
                                {"\u00b7"}
                              </span>
                              <span>{longNameSuffix}</span>
                            </span>
                          )}
                        </h1>
                        <p>{companySubtitleText}</p>
                      </div>
                    </div>

                    <div className="trade-hero-stats">
                      <div className="trade-stat">
                        <span className="trade-stat-label">
                          {t("trade.field.inPortfolio")}
                        </span>
                        <strong className="trade-stat-value">
                          {fmtQty(posQty)}
                        </strong>
                      </div>
                      <div className="trade-stat">
                        <span className="trade-stat-label">
                          {t("trade.field.lastPrice")}
                        </span>
                        <strong className="trade-stat-value">
                          {last ? `$${last.toFixed(2)}` : "-"}
                        </strong>
                      </div>
                      <div className="trade-stat">
                        <span className="trade-stat-label">
                          {t("trade.field.creditsLabel")}
                        </span>
                        <strong className="trade-stat-value">
                          ${cash.toFixed(2)}
                        </strong>
                      </div>
                    </div>
                  </div>

                  <div className="trade-form">
                    <div className="trade-grid trade-grid--compact">
                      <div className="field trade-field--fill">
                        <div className="trade-input-row">
                          <div className="trade-input-primary">
                            <label>
                              {mode === "qty"
                                ? t("trade.field.quantityLabel")
                                : t("trade.field.amountLabel")}
                            </label>
                            {mode === "qty" ? (
                              <input
                                className="input"
                                type="number"
                                min={0}
                                step="any"
                                value={Number.isFinite(qty) ? qty : ""}
                                onChange={(event) => {
                                  const { value } = event.target;
                                  setQty(value === "" ? NaN : Number(value));
                                }}
                              />
                            ) : (
                              <input
                                className="input"
                                type="number"
                                min={0}
                                step="0.01"
                                value={Number.isFinite(amount) ? amount : ""}
                                onChange={(event) => {
                                  const { value } = event.target;
                                  setAmount(value === "" ? NaN : Number(value));
                                }}
                              />
                            )}
                          </div>
                          <div className="trade-mode-info">
                            <p className="hint trade-mode-hint">
                              {mode === "qty"
                                ? t("trade.hint.quantity")
                                : t("trade.hint.amount")}
                            </p>
                            <div className="seg trade-mode-seg">
                              <button
                                type="button"
                                className={mode === "qty" ? "on" : ""}
                                onClick={() => setMode("qty")}
                              >
                                {t("trade.mode.enterQuantity")}
                              </button>
                              <button
                                type="button"
                                className={mode === "amount" ? "on" : ""}
                                onClick={() => setMode("amount")}
                              >
                                {t("trade.mode.enterAmount")}
                              </button>
                            </div>
                          </div>
                          <div className="trade-estimate">
                            <span>
                              {mode === "qty"
                                ? t("trade.field.estimatedCost")
                                : t("trade.field.estimatedQuantity")}
                            </span>
                            <strong>
                              {mode === "qty"
                                ? last
                                  ? `$${(qty * last).toFixed(2)}`
                                  : "-"
                                : fmtQty(previewQty)}
                            </strong>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="trade-actions">
                      <button
                        className="btn btn-accent trade-action"
                        disabled={
                          loading ||
                          !Number.isFinite(previewQty) ||
                          previewQty <= 0
                        }
                        onClick={() => place("buy")}
                      >
                        {t("trade.actions.buy")}
                      </button>
                      <button
                        className="btn btn-sell trade-action"
                        disabled={
                          loading ||
                          !Number.isFinite(previewQty) ||
                          previewQty <= 0
                        }
                        onClick={() => place("sell")}
                      >
                        {t("trade.actions.sell")}
                      </button>
                    </div>
                  </div>

                  {msg && <div className="trade-msg">{msg}</div>}
                </section>

                <section className="trade-conditional-card">
                  <div className="trade-conditional-header">
                    <div>
                      <h3>{t("trade.schedule.title")}</h3>
                      <p>{t("trade.schedule.description")}</p>
                    </div>
                    <div className="trade-conditional-meta">
                      <div className="meta-chip">
                        <span>{t("trade.schedule.orders.title")}</span>
                        <strong>{pendingConditionalOrders.length}</strong>
                      </div>
                      <div className="meta-chip">
                        <span>{t("trade.field.lastPrice")}</span>
                        <strong>{last ? `$${last.toFixed(2)}` : "-"}</strong>
                      </div>
                      <div className="meta-chip">
                        <span>{t("trade.field.creditsLabel")}</span>
                        <strong>${cash.toFixed(2)}</strong>
                      </div>
                    </div>
                  </div>

                  <form
                    className="trade-conditional-form"
                    onSubmit={handleScheduleConditional}
                  >
                    <div className="trade-conditional-row">
                      <div className="field trade-field--fill trade-field-full">
                        <div className="trade-input-row">
                          <div className="trade-input-primary">
                            <label>
                              {conditionalMode === "qty"
                                ? t("trade.schedule.field.qty")
                                : t("trade.schedule.field.amount")}
                            </label>
                            {conditionalMode === "qty" ? (
                              <input
                                className="input"
                                type="number"
                                min={0}
                                step="any"
                                value={
                                  Number.isFinite(conditionalQty)
                                    ? conditionalQty
                                    : ""
                                }
                                onChange={(event) => {
                                  const { value } = event.target;
                                  setConditionalQty(
                                    value === "" ? NaN : Number(value),
                                  );
                                }}
                              />
                            ) : (
                              <input
                                className="input"
                                type="number"
                                min={0}
                                step="0.01"
                                value={
                                  Number.isFinite(conditionalAmount)
                                    ? conditionalAmount
                                    : ""
                                }
                                onChange={(event) => {
                                  const { value } = event.target;
                                  setConditionalAmount(
                                    value === "" ? NaN : Number(value),
                                  );
                                }}
                              />
                            )}
                          </div>
                          <div className="trade-mode-info">
                            <p className="hint trade-mode-hint">
                              {conditionalMode === "qty"
                                ? t("trade.hint.quantity")
                                : t("trade.hint.amount")}
                            </p>
                            <div className="seg trade-mode-seg">
                              <button
                                type="button"
                                className={
                                  conditionalMode === "qty" ? "on" : ""
                                }
                                onClick={() => setConditionalMode("qty")}
                              >
                                {t("trade.mode.enterQuantity")}
                              </button>
                              <button
                                type="button"
                                className={
                                  conditionalMode === "amount" ? "on" : ""
                                }
                                onClick={() => setConditionalMode("amount")}
                              >
                                {t("trade.mode.enterAmount")}
                              </button>
                            </div>
                          </div>
                          <div className="trade-estimate">
                            <span>
                              {conditionalMode === "qty"
                                ? t("trade.field.estimatedCost")
                                : t("trade.field.estimatedQuantity")}
                            </span>
                            <strong>
                              {conditionalMode === "qty"
                                ? Number.isFinite(conditionalTriggerPrice) &&
                                  conditionalTriggerPrice > 0
                                  ? `$${(scheduledQtyPreview * conditionalTriggerPrice).toFixed(2)}`
                                  : "-"
                                : fmtQty(scheduledQtyPreview)}
                            </strong>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="trade-conditional-row">
                      <div className="field trade-select-field">
                        <label>{t("trade.schedule.field.side")}</label>
                        <TradeSelect
                          value={conditionalSide}
                          onChange={(next) =>
                            setConditionalSide(next as "buy" | "sell")
                          }
                          options={[
                            {
                              value: "buy",
                              label: t("trade.schedule.side.buy"),
                            },
                            {
                              value: "sell",
                              label: t("trade.schedule.side.sell"),
                            },
                          ]}
                        />
                      </div>

                      <div className="field trade-select-field">
                        <label>{t("trade.schedule.field.triggerType")}</label>
                        <TradeSelect
                          value={conditionalTriggerType}
                          onChange={(next) =>
                            setConditionalTriggerType(next as TriggerType)
                          }
                          options={[
                            {
                              value: "gte",
                              label: t("trade.schedule.triggerType.gte"),
                            },
                            {
                              value: "lte",
                              label: t("trade.schedule.triggerType.lte"),
                            },
                          ]}
                        />
                      </div>

                      <div className="field trade-field-shrink">
                        <label>{t("trade.schedule.field.triggerPrice")}</label>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step="0.01"
                          value={conditionalTriggerPrice}
                          onChange={(event) =>
                            setConditionalTriggerPrice(
                              Number(event.target.value),
                            )
                          }
                        />
                      </div>

                      <div className="trade-actions inline">
                        <button
                          type="submit"
                          className="btn btn-accent"
                          disabled={conditionalLoading}
                        >
                          {t("trade.schedule.submit")}
                        </button>
                      </div>
                    </div>
                  </form>

                  {conditionalMsg && (
                    <div className="trade-msg">{conditionalMsg}</div>
                  )}
                </section>

                <section className="trade-conditional-orders">
                  <div className="trade-conditional-header">
                    <div>
                      <h3>{t("trade.schedule.orders.title")}</h3>
                    </div>
                  </div>
                  <div className="trade-orders-table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left" }}>
                            {t("portfolio.table.headers.company") ||
                              t("trade.schedule.orders.headers.symbol")}
                          </th>
                          <th>{t("trade.schedule.orders.headers.side")}</th>
                          <th>{t("trade.schedule.orders.headers.qty")}</th>
                          <th>{t("trade.schedule.orders.headers.trigger")}</th>
                          <th>{t("trade.schedule.orders.headers.status")}</th>
                          <th>{t("trade.schedule.orders.headers.error")}</th>
                          <th>{t("trade.schedule.orders.headers.actions")}</th>
                        </tr>
                      </thead>

                      <tbody>
                        {sortedConditionalOrders.length === 0 ? (
                          <tr>
                            <td
                              colSpan={7}
                              style={{
                                textAlign: "center",
                                color: "var(--text-muted)",
                              }}
                            >
                              {t("trade.schedule.orders.empty")}
                            </td>
                          </tr>
                        ) : (
                          sortedConditionalOrders.map((order) => {
                            const directionSymbol =
                              order.triggerType === "gte" ? ">=" : "<=";
                            const company = companyBySymbol.get(order.symbol);
                            const companyLogo = company?.logo
                              ? assetPath(company.logo)
                              : placeholderLogoPath;
                            const companyName = company?.name || order.symbol;
                            const statusTone = statusBadgeTone(order.status);
                            const sideTone =
                              order.side === "buy" ? "buy" : "sell";
                            return (
                              <tr key={order.id}>
                                <td style={{ textAlign: "left" }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 10,
                                    }}
                                  >
                                    <LogoBadge
                                      src={companyLogo}
                                      alt={`${companyName} logo`}
                                      size={24}
                                    />
                                    <div
                                      style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        lineHeight: 1.2,
                                      }}
                                    >
                                      <span style={{ fontWeight: 700 }}>
                                        {companyName}
                                      </span>
                                      <span
                                        style={{
                                          fontSize: "0.8rem",
                                          color: "var(--text-muted)",
                                        }}
                                      >
                                        {order.symbol}
                                      </span>
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <span
                                    className={`trade-badge trade-badge--${sideTone}`}
                                  >
                                    {order.side === "buy"
                                      ? t("trade.actions.buy")
                                      : t("trade.actions.sell")}
                                  </span>
                                </td>
                                <td className="num">{fmtQty(order.qty)}</td>
                                <td className="num">
                                  {directionSymbol}{" "}
                                  {fmtValue(order.triggerPrice ?? 0)}
                                </td>
                                <td>
                                  <span
                                    className={`trade-badge trade-badge--${statusTone}`}
                                  >
                                    {statusLabel(order.status)}
                                  </span>
                                </td>
                                <td>
                                  {order.lastError ? (
                                    <span className="neg">
                                      {order.lastError}
                                    </span>
                                  ) : (
                                    <span
                                      style={{ color: "var(--text-muted)" }}
                                    >
                                      -
                                    </span>
                                  )}
                                </td>
                                <td style={{ textAlign: "right" }}>
                                  {canCancel(order.status) ? (
                                    <button
                                      type="button"
                                      className="btn"
                                      onClick={() =>
                                        handleCancelConditional(order.id)
                                      }
                                    >
                                      {t("trade.schedule.orders.cancel")}
                                    </button>
                                  ) : (
                                    <span
                                      style={{ color: "var(--text-muted)" }}
                                    >
                                      -
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="trade-conditional-orders trade-positions-card">
                  <div className="trade-conditional-header">
                    <div>
                      <h3>{t("trade.positions.title")}</h3>
                    </div>
                  </div>
                  <div className="trade-orders-table">
                    <PositionsTable
                      rows={portfolioRows}
                      companies={companies}
                      loading={loadingPrices}
                      t={t}
                      assetPath={assetPath}
                      placeholderLogoPath={placeholderLogoPath}
                      locale={locale}
                      showActions
                      actionLabel={t("trade.actions.sell")}
                      onAction={handlePrefillSell}
                    />
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Check if a conditional order should fire at the provided market price. */
/** Determine whether a conditional order threshold is met at the given price. */
function shouldTrigger(order: ConditionalOrder, price: number) {
  if (!Number.isFinite(price) || price <= 0) return false;
  const target = order.triggerPrice ?? 0;
  if (!Number.isFinite(target) || target <= 0) return false;
  const epsilon = 1e-6;
  if (order.triggerType === "gte") {
    return price >= target - epsilon;
  }
  return price <= target + epsilon;
}

/** Format quantities with up to 6 decimals for hero stats and tables. */
function fmtQty(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

type TradeSelectOption<T extends string> = { value: T; label: string };

/** Lightweight custom select used in the trade scheduler. */
/** Minimal custom select used in the scheduler and side pickers. */
function TradeSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: TradeSelectOption<T>[];
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((opt) => opt.value === value) ?? options[0];

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className={`trade-select${open ? " open" : ""}`} ref={wrapperRef}>
      <button
        type="button"
        className="trade-select-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current?.label}</span>
        <span className="trade-select-caret" aria-hidden="true" />
      </button>
      {open && (
        <ul className="trade-select-menu" role="listbox">
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                className={option.value === value ? "active" : ""}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                aria-selected={option.value === value}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
