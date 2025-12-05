import { useEffect, useMemo, useState } from "react";
import { auth } from "../firebase";
import { usePortfolioSnapshot } from "../lib/usePortfolioSnapshot";
import { useWealthHistory } from "../lib/useWealthHistory";
import { useI18n } from "../i18n/I18nProvider";
import provider from "../lib/prices";
import PositionsTable from "../components/PositionsTable";
import {
  buildOpenLots,
  buildPositionRows,
  formatCompactValue,
  type PositionRow,
} from "../lib/positionsTable";

// Additional helpers to fetch names/logos like Explore does
import { fetchCompaniesIndex, type Company } from "../lib/companies";

import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  type TooltipContentProps,
} from "recharts";

// --- UI helpers ---
const EPSILON = 1e-9;

/**
 * Mirror Explore's BASE_URL-safe asset helper so we can load logos consistently.
 */
const assetPath = (path: string) => {
  if (/^https?:/i.test(path)) return path;
  const base =
    ((import.meta as any).env?.BASE_URL as string | undefined) ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const trimmed = path.replace(/^\/+/, "");
  return `${normalizedBase}${trimmed}`;
};

const PLACEHOLDER_LOGO = assetPath("img/logo-placeholder.svg");

const PIE_COLORS = [
  "#6366F1",
  "#22C55E",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#84CC16",
  "#A855F7",
  "#F97316",
  "#60A5FA",
  "#10B981",
];
const OTHERS_COLOR = "rgba(148,163,184,0.85)";
const THRESHOLD_PCT = 0.03;
const fmt = formatCompactValue;

export default function Portfolio() {
  const { t, locale } = useI18n();
  const uid = auth.currentUser?.uid ?? null;
  const {
    orders,
    positions,
    prices,
    cash,
    marketValue,
    totalValue,
    loadingPrices,
  } = usePortfolioSnapshot(uid);
  const { history: wealthHistory, loading: loadingWealthHistory } =
    useWealthHistory(uid);

  // Future versions of usePortfolioSnapshot may expose cashByCcy;
  // until then, treat all cash as USD.
  const cashByCcy: Record<string, number> = (usePortfolioSnapshot as any)
    ?.cashByCcy || { USD: cash };

  // --- convert liquidity pockets into USD equivalents ---
  // fxRatesUSD["USD"]=1 ; fxRatesUSD["EUR"]=EURUSD ; fxRatesUSD["JPY"]=1 / USDJPY ; etc.
  const [fxRatesUSD, setFxRatesUSD] = useState<Record<string, number>>({
    USD: 1,
  });

  useEffect(() => {
    let aborted = false;
    (async () => {
      const ccys = Object.keys(cashByCcy)
        .map((c) => c.toUpperCase())
        .filter((c) => c !== "USD");
      if (!ccys.length) {
        setFxRatesUSD({ USD: 1 });
        return;
      }

      const next: Record<string, number> = { USD: 1 };
      for (const ccy of ccys) {
        try {
          // Direct quote: EURUSD, GBPUSD, etc. (USD per unit of currency)
          const direct = await provider.getLastPrice(`${ccy}USD`);
          if (Number.isFinite(direct) && direct > 0) {
            next[ccy] = direct;
            continue;
          }

          // Otherwise try inverse pairs (USDJPY, USDCHF, etc.) and invert
          const inverse = await provider.getLastPrice(`USD${ccy}`);
          if (Number.isFinite(inverse) && inverse > 0) {
            next[ccy] = 1 / inverse;
            continue;
          }

          next[ccy] = 1; // neutral fallback when the pair is unavailable
        } catch {
          next[ccy] = 1;
        }
      }
      if (!aborted) setFxRatesUSD(next);
    })();
    return () => {
      aborted = true;
    };
  }, [JSON.stringify(Object.keys(cashByCcy).sort())]);

  // Load the companies index to enrich rows with names/logos
  const [companies, setCompanies] = useState<Company[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idx = await fetchCompaniesIndex();
        if (!cancelled) setCompanies(idx);
      } catch {
        // Fail silently; UI already falls back when there is no name/logo
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Stable colors for major currencies (teal variations)
  const CASH_COLORS: Record<string, string> = {
    USD: "#0F766E",
    EUR: "#0EA5E9",
    JPY: "#06B6D4",
    GBP: "#14B8A6",
    CHF: "#0891B2",
  };

  const normalizeCcy = (x: string) => x?.trim().toUpperCase();

  const bySymbol = useMemo(() => {
    const map = new Map<string, Company>();
    for (const c of companies) map.set(c.symbol, c);
    return map;
  }, [companies]);

  const openLots = useMemo(() => buildOpenLots(orders), [orders]);
  const rows: PositionRow[] = useMemo(
    () => buildPositionRows(openLots, prices),
    [openLots, prices],
  );

  // Position slices (excluding cash). Very small weights collapse into "Others".
  type Slice = {
    key: string;
    label: string;
    value: number;
    symbol?: string;
    isOthers?: boolean;
    color?: string; // keep colors aligned between chart and legend
    unit?: string;
  };

  const rawCurrencyUnit = t("portfolio.currency.unit");
  const currencyUnit =
    rawCurrencyUnit === "portfolio.currency.unit" ? "USD" : rawCurrencyUnit;

  const compositionBase: Slice[] = useMemo(() => {
    const slices: Slice[] = [];
    for (const [symbol, pos] of Object.entries(positions)) {
      const qty = pos.qty;
      if (Math.abs(qty) <= EPSILON) continue;
      const px = prices[symbol];
      if (typeof px !== "number" || !Number.isFinite(px)) continue;
      const value = qty * px;
      if (value <= 0) continue;
      const comp = bySymbol.get(symbol);
      const label = comp?.name || symbol;
      slices.push({ key: symbol, label, value, symbol });
    }
    return slices.sort((a, b) => b.value - a.value);
  }, [positions, prices, bySymbol]);

  const pieData: Slice[] = useMemo(() => {
    const total = compositionBase.reduce((acc, slice) => acc + slice.value, 0);
    if (total <= 0) return [];

    const big: Slice[] = [];
    const small: Slice[] = [];
    for (const slice of compositionBase) {
      (slice.value / total >= THRESHOLD_PCT ? big : small).push(slice);
    }

    if (small.length) {
      big.push({
        key: "__OTHERS__",
        label: (t("portfolio.composition.others") as string) || "Others",
        value: small.reduce((acc, s) => acc + s.value, 0),
        isOthers: true,
      });
    }

    // Assign colors here so legend + tooltips stay in sync even if we reorder
    return big.map((s, idx) => ({
      ...s,
      color: s.isOthers ? OTHERS_COLOR : PIE_COLORS[idx % PIE_COLORS.length],
      unit: currencyUnit,
    }));
  }, [compositionBase, t, currencyUnit]);

  const pieWithCashData: Slice[] = useMemo(() => {
    const positions = pieData.map((s) => ({ ...s })); // preserve existing slice colors

    // Build cash slices for each currency bucket
    const cashSlices: Slice[] = Object.entries(cashByCcy)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([ccy, v]) => {
        const normalized = normalizeCcy(ccy);
        return {
          key: `__CASH_${normalized}__`,
          label: `${(t("portfolio.composition.cash") as string) || "Cash"} ${normalized}`,
          value: v,
          color: CASH_COLORS[normalized] || "#0F766E",
          unit: normalized,
        };
      });

    if (!positions.length && !cashSlices.length) return [];
    return [...positions, ...cashSlices];
  }, [pieData, cashByCcy, t]);
  const pieTotal = useMemo(
    () => pieData.reduce((acc, slice) => acc + slice.value, 0),
    [pieData],
  );
  const pieWithCashTotal = useMemo(
    () => pieWithCashData.reduce((acc, slice) => acc + slice.value, 0),
    [pieWithCashData],
  );
  type HistPoint = {
    label: string;
    stocks: number;
    cash: number;
    total?: number;
    ts?: Date | null;
    source?: string | null;
  };

  const historyDateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale],
  );
  const historyTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale],
  );

  /* Portfolio history pulled from Firebase snapshots */
  const historyData: HistPoint[] = useMemo(() => {
    const baseEntries = wealthHistory.length
      ? wealthHistory
      : [
          {
            cash: totalSafe(cash),
            stocks: totalSafe(marketValue),
            total: totalSafe(totalValue),
            ts: new Date(),
            source: "live",
          },
        ];

    return baseEntries.map((entry) => {
      const ts = entry.ts ?? new Date();
      const dateLabel = historyDateFormatter.format(ts);
      const timeLabel = historyTimeFormatter.format(ts);
      return {
        label: `${dateLabel}\n${timeLabel}`,
        stocks: totalSafe(entry.stocks),
        cash: totalSafe(entry.cash),
        total: totalSafe(entry.total ?? entry.cash + entry.stocks),
        ts,
        source: entry.source ?? null,
      };
    });
  }, [
    wealthHistory,
    historyDateFormatter,
    historyTimeFormatter,
    cash,
    marketValue,
    totalValue,
  ]);

  /**
   * Compact legend that lists each slice with its percentage and USD value.
   * Works for both position slices and cash pockets (converted via fxRatesUSD).
   */
  function LegendTable({
    data,
    bySymbol,
    fxRatesUSD,
  }: {
    data: Slice[];
    bySymbol: Map<string, Company>;
    fxRatesUSD: Record<string, number>;
    showLogos?: boolean;
  }) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        {data
          .slice()
          .sort((a, b) => b.value - a.value)
          .map((s) => {
            const isCash = s.key.startsWith("__CASH_");
            const ccy = isCash ? s.key.replace("__CASH_", "") : "";
            const comp =
              !isCash && s.symbol ? bySymbol.get(s.symbol) : undefined;
            const logo = comp?.logo ? assetPath(comp.logo) : PLACEHOLDER_LOGO;
            const usd = isCash ? s.value * (fxRatesUSD[ccy] ?? 1) : s.value;
            const pct =
              (s.value / (data.reduce((a, x) => a + x.value, 0) || 1)) * 100;

            // Layout: color chip | (logo + name) | % | converted value
            return (
              <div
                key={s.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "12px minmax(0,1fr) 68px 90px",
                  alignItems: "center",
                  gap: 10,
                  lineHeight: 1.15,
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: s.color || "#999",
                    boxShadow: "0 0 0 2px rgba(0,0,0,0.05)",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  {!isCash && !s.isOthers && (
                    <img
                      src={logo}
                      alt=""
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        objectFit: "contain",
                        flex: "0 0 auto",
                      }}
                    />
                  )}
                  <strong
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.label}
                  </strong>
                </div>
                <span className="hint" style={{ textAlign: "right" }}>
                  {pct.toFixed(1)}%
                </span>
                <span className="hint" style={{ textAlign: "right" }}>
                  {fmt(usd)}
                </span>
              </div>
            );
          })}
      </div>
    );
  }

  return (
    <div className="page-main portfolio-page">
      <div className="container">
        {/* Page header */}
        <header className="portfolio-header">
          <div className="portfolio-title-card">
            <h1>{t("portfolio.title")}</h1>
          </div>
        </header>

        {/* ===== KPI tiles with info-tooltips ===== */}
        <div className="grid-cards">
          <div className="kpi-card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <div className="kpi-k">{t("portfolio.cards.cash")}</div>
              <span className="info-tooltip" aria-hidden="false">
                <button
                  type="button"
                  className="info-btn"
                  aria-label={`${t("portfolio.cards.cash")}: ${t("portfolio.help.cash") ?? "Cash available for purchases"}`}
                >
                  i
                </button>
                <span role="tooltip" className="info-tooltip-content">
                  {t("portfolio.help.cash") ??
                    "Amount of immediately available cash to execute buys."}
                </span>
              </span>
            </div>
            <div className="kpi-v">
              <span>{fmt(totalSafe(cash))}</span>
              <span className="kpi-unit">{currencyUnit}</span>
            </div>
          </div>

          <div className="kpi-card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <div className="kpi-k">{t("portfolio.cards.positionValue")}</div>
              <span className="info-tooltip">
                <button
                  type="button"
                  className="info-btn"
                  aria-label={`${t("portfolio.cards.positionValue")}: ${t("portfolio.help.positionValue") ?? "Current market value of positions"}`}
                >
                  i
                </button>
                <span role="tooltip" className="info-tooltip-content">
                  {t("portfolio.help.positionValue") ??
                    "Sum of the current values (last price x quantity) of every position."}
                </span>
              </span>
            </div>
            <div className="kpi-v">
              <span>{fmt(totalSafe(marketValue))}</span>
              <span className="kpi-unit">{currencyUnit}</span>
            </div>
          </div>

          <div className="kpi-card">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <div className="kpi-k">{t("portfolio.cards.totalValue")}</div>
              <span className="info-tooltip">
                <button
                  type="button"
                  className="info-btn"
                  aria-label={`${t("portfolio.cards.totalValue")}: ${t("portfolio.help.totalValue") ?? "Cash plus value of positions"}`}
                >
                  i
                </button>
                <span role="tooltip" className="info-tooltip-content">
                  {t("portfolio.help.totalValue") ??
                    "Cash plus the value of your positions (total portfolio equity)."}
                </span>
              </span>
            </div>
            <div className="kpi-v">
              <span>{fmt(totalSafe(totalValue))}</span>
              <span className="kpi-unit">{currencyUnit}</span>
            </div>
          </div>
        </div>

        {/* ===== Dual composition donuts ===== */}
        {(pieData.length > 0 || pieWithCashData.length > 0) && (
          <div className="grid-charts-2">
            {/* ===== Positions-only donut ===== */}
            {pieData.length > 0 && (
              <div className="chart-card" style={{ marginTop: 8 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: 8,
                  }}
                >
                  <h3 className="insight-panel-title" style={{ margin: 0 }}>
                    {(t("portfolio.composition.title") as string) ||
                      "Portfolio composition"}
                  </h3>
                  <div className="hint" style={{ margin: 0 }}>
                    {(t("portfolio.composition.note") as string) ||
                      "Excludes cash"}
                  </div>
                </div>

                <div
                  style={{
                    minHeight: 260,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 16,
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      maxWidth: 360,
                      height: 260,
                      minWidth: 0,
                    }}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="label"
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          labelLine={false}
                          isAnimationActive={false}
                        >
                          {pieData.map((entry) => (
                            <Cell
                              key={entry.key}
                              fill={entry.color || OTHERS_COLOR}
                              stroke="rgba(255,255,255,0.85)"
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          content={
                            <PieTooltip total={pieTotal} unit={currencyUnit} />
                          }
                          wrapperStyle={{ zIndex: 9999, pointerEvents: "none" }}
                          contentStyle={{
                            backgroundColor: "transparent",
                            border: "none",
                            boxShadow: "none",
                            padding: 0,
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Legend below the chart (mirrors the right-hand layout) */}
                  <div style={{ width: "100%", maxWidth: 360 }}>
                    <LegendTable
                      data={pieData}
                      bySymbol={bySymbol}
                      fxRatesUSD={{ USD: 1 }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ===== Donut including cash ===== */}
            {pieWithCashData.length > 0 && (
              <div className="chart-card" style={{ marginTop: 8 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: 8,
                  }}
                >
                  <h3 className="insight-panel-title" style={{ margin: 0 }}>
                    {(t("portfolio.composition.withCash.title") as string) ||
                      "Portfolio (with cash)"}
                  </h3>
                  <div className="hint" style={{ margin: 0 }}>
                    {(t("portfolio.composition.withCash.note") as string) ||
                      "Includes cash"}
                  </div>
                </div>

                <div style={{ minHeight: 260, minWidth: 0 }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie
                        data={pieWithCashData}
                        dataKey="value"
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        labelLine={false}
                        isAnimationActive={false}
                      >
                        {pieWithCashData.map((entry) => (
                          <Cell
                            key={entry.key}
                            fill={entry.color || OTHERS_COLOR}
                            stroke="rgba(255,255,255,0.85)"
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        content={
                          <PieTooltip
                            total={pieWithCashTotal}
                            unit={currencyUnit}
                          />
                        }
                        wrapperStyle={{ zIndex: 9999, pointerEvents: "none" }}
                        contentStyle={{
                          backgroundColor: "transparent",
                          border: "none",
                          boxShadow: "none",
                          padding: 0,
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                {/* Detailed legend */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    alignSelf: "center",
                  }}
                >
                  <LegendTable
                    data={pieWithCashData}
                    bySymbol={bySymbol}
                    fxRatesUSD={fxRatesUSD}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== Stacked Area Chart ===== */}
        {historyData.length > 0 && (
          <div className="chart-card" style={{ marginTop: 8 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 8,
              }}
            >
              <h3 className="insight-panel-title" style={{ margin: 0 }}>
                {(t("portfolio.history.title") as string) ||
                  "Portfolio history"}
              </h3>
              {loadingWealthHistory && (
                <div className="hint" style={{ margin: 0 }}>
                  {(t("app.loading") as string) || "Syncing..."}
                </div>
              )}
            </div>

            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={historyData}
                  margin={{ top: 10, right: 24, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    stroke="rgba(0,0,0,0.1)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 12, fill: "#475569" }}
                    minTickGap={18}
                  />
                  <YAxis
                    tickFormatter={(n: number) =>
                      n.toLocaleString(undefined, { maximumFractionDigits: 0 })
                    }
                    tick={{ fontSize: 12, fill: "#475569" }}
                  />
                  <Tooltip
                    formatter={(v: any, name: any) => [
                      fmt(Number(v) || 0),
                      name === "stocks"
                        ? (t("portfolio.history.stocks") as string) || "Stocks"
                        : (t("portfolio.history.cash") as string) || "Cash",
                    ]}
                    labelFormatter={(lab: any) =>
                      String(lab).split("\n").join(" \u00B7 ")
                    }
                  />
                  {/* Cash layer */}
                  <Area
                    type="monotone"
                    dataKey="cash"
                    stackId="1"
                    stroke="#2563EB"
                    fill="rgba(37,99,235,0.45)"
                  />
                  {/* Stock layer */}
                  <Area
                    type="monotone"
                    dataKey="stocks"
                    stackId="1"
                    stroke="#16A34A"
                    fill="rgba(22,163,74,0.5)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div
              style={{
                display: "flex",
                gap: 16,
                justifyContent: "center",
                marginTop: 12,
                flexWrap: "wrap",
              }}
            >
              {[
                {
                  key: "stocks",
                  color: "#16A34A",
                  label: (t("portfolio.history.stocks") as string) || "Stocks",
                },
                {
                  key: "cash",
                  color: "#2563EB",
                  label: (t("portfolio.history.cash") as string) || "Cash",
                },
              ].map((entry) => (
                <div
                  key={entry.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 14,
                    color: "#0f172a",
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 4,
                      backgroundColor: entry.color,
                      display: "inline-block",
                    }}
                  />
                  <span>{entry.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===== Positions table ===== */}
        <PositionsTable
          rows={rows}
          companies={companies}
          loading={loadingPrices}
          t={t}
          assetPath={assetPath}
          placeholderLogoPath={PLACEHOLDER_LOGO}
          locale={locale}
        />

        <p className="hint">{t("portfolio.hint")}</p>
      </div>
    </div>
  );
}

/** Guard against NaN/Infinity when calculating totals. */
function totalSafe(n: number) {
  return Number.isFinite(n) ? n : 0;
}

type PieTooltipProps = Partial<TooltipContentProps<number, string>> & {
  total: number;
  unit: string;
};

/**
 * Shared donut tooltip showing label, percent, and absolute value.
 */
function PieTooltip(props: PieTooltipProps) {
  const { active, total, unit: fallbackUnit, payload = [] } = props;
  if (!active || payload.length === 0) return null;

  const entry = payload[0];
  const slice: any = entry?.payload ?? {};
  const label = slice?.label ?? entry?.name ?? "";
  const color: string = slice?.color ?? entry?.color ?? "#6366F1";

  const rawValue =
    typeof entry?.value === "number"
      ? entry.value
      : typeof slice?.value === "number"
        ? slice.value
        : Number(entry?.value ?? slice?.value ?? Number.NaN);
  const safeValue = Number.isFinite(rawValue) ? rawValue : 0;
  const sliceUnit = slice?.unit ?? slice?.currency ?? fallbackUnit ?? "";
  const percentFraction = total ? safeValue / total : 0;
  const percentLabel = Number.isFinite(percentFraction)
    ? `${(percentFraction * 100).toFixed(1)}%`
    : null;
  const valueLabel = safeValue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const unitLabel = sliceUnit ? `${valueLabel} ${sliceUnit}` : valueLabel;

  if (!label && !percentLabel && !unitLabel) return null;

  return (
    <div className="pie-hover-label" style={{ borderColor: color }}>
      <div className="pie-hover-label-header">
        <span
          className="pie-hover-label-dot"
          style={{ backgroundColor: color }}
        />
        <span className="pie-hover-label-name">
          {label || percentLabel || unitLabel}
        </span>
      </div>
      {(percentLabel || unitLabel) && (
        <div className="pie-hover-label-meta">
          {percentLabel && (
            <span className="pie-hover-label-percent">{percentLabel}</span>
          )}
          {percentLabel && unitLabel && (
            <span className="pie-hover-label-separator">{"\u00b7"}</span>
          )}
          {unitLabel && (
            <span className="pie-hover-label-value">{unitLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
