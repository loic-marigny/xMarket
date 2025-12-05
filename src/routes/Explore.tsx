import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  createChart,
  type BusinessDay,
  type CandlestickData,
  type Time,
  type ISeriesApi,
  type IChartApi,
} from "lightweight-charts";
import provider, { type OHLC } from "../lib/prices";
import {
  fetchCompaniesIndex,
  fetchCompanyProfile,
  type Company,
  type CompanyProfile,
  marketLabel,
} from "../lib/companies";
import { useI18n } from "../i18n/I18nProvider";
import "./Explore.css";
import {
  BarChart as RBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ReferenceLine,
  ResponsiveContainer,
  PieChart,
  Pie,
} from "recharts";
import { auth } from "../firebase";
import { usePortfolioSnapshot } from "../lib/usePortfolioSnapshot";
import { submitSpotOrder } from "../lib/trading";
import CompanySidebar from "../components/CompanySidebar";

type TF = "1M" | "6M" | "YTD" | "1Y" | "MAX";

type GaugeVariant = "circular" | "linear";

type GaugeConfig = {
  value: number;
  min: number;
  max: number;
  format: (value: number) => string;
  variant?: GaugeVariant;
  target?: number;
};

type InsightItem = {
  key: string;
  label: string;
  description?: string;
  content?: ReactNode;
  gauge?: GaugeConfig;
};

type RangeItem = {
  key: string;
  label: string;
  description?: string;
  low: number;
  high: number;
  current: number;
  lowDate?: string;
  highDate?: string;
  currentDate?: string;
  lowLabel?: string;
  highLabel?: string;
  currentLabel?: string;
};

type MetricRow = {
  key: string;
  label: string;
  value: ReactNode;
};

const DEFAULT_LOGO_STYLE: CSSProperties = {
  padding: 12,
  background:
    "linear-gradient(135deg, rgba(244,247,254,0.95), rgba(226,232,240,0.7))",
  border: "1px solid rgba(15,23,42,0.12)",
  boxShadow: "0 4px 14px rgba(15,23,42,0.16)",
};

const assetPath = (path: string) => {
  if (/^https?:/i.test(path)) return path;
  const base =
    ((import.meta as any).env?.BASE_URL as string | undefined) ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const trimmed = path.replace(/^\/+/, "");
  return `${normalizedBase}${trimmed}`;
};

const toBusinessDay = (value: string | Date): BusinessDay => {
  if (typeof value === "string") {
    const [year, month, day] = value
      .split("-")
      .map((x) => Number.parseInt(x, 10));
    return { year, month, day } as BusinessDay;
  }
  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
  } as BusinessDay;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const numberFormatter = (
  maximumFractionDigits = 2,
  minimumFractionDigits = 0,
) =>
  new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    minimumFractionDigits,
  });

const formatNumberValue = (
  value: number,
  maximumFractionDigits = 2,
  minimumFractionDigits = 0,
) =>
  numberFormatter(maximumFractionDigits, minimumFractionDigits).format(value);

const currencyFormatter = (maximumFractionDigits = 0) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  });

const compactCurrencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const formatUSD = (value: number, maximumFractionDigits = 0) =>
  currencyFormatter(maximumFractionDigits).format(value);

const formatCompactUSD = (value: number) =>
  compactCurrencyFormatter.format(value);

/**
 * Sample a company logo and derive padding/background styles so the logo
 * always displays on a readable card regardless of its native colors.
 */
const analyzeLogoAppearance = async (src: string): Promise<CSSProperties> => {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  const size = 64;

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("logo-load-failed"));
    image.src = src;
  });

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return DEFAULT_LOGO_STYLE;
  }
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, size, size);

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, size, size);
  } catch {
    return DEFAULT_LOGO_STYLE;
  }
  const data = imageData.data;
  let brightnessSum = 0;
  let pixelCount = 0;
  let edgePixels = 0;
  let opaqueEdgePixels = 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      if (a < 15) continue;
      pixelCount += 1;
      brightnessSum += 0.299 * r + 0.587 * g + 0.114 * b;
      const isEdge = x < 2 || x >= size - 2 || y < 2 || y >= size - 2;
      if (isEdge) {
        edgePixels += 1;
        if (a > 230) opaqueEdgePixels += 1;
      }
    }
  }

  const hasOpaqueFrame = edgePixels > 0 && opaqueEdgePixels / edgePixels > 0.85;
  if (hasOpaqueFrame) {
    return {
      padding: 0,
      background: "transparent",
      border: "0",
      boxShadow: "none",
      objectFit: "cover",
    };
  }

  const avgBrightness = pixelCount > 0 ? brightnessSum / pixelCount : 200;
  if (avgBrightness < 140) {
    return {
      padding: 12,
      background:
        "linear-gradient(135deg, rgba(248,250,252,0.96), rgba(226,232,240,0.72))",
      border: "1px solid rgba(15,23,42,0.18)",
      boxShadow: "0 4px 16px rgba(15,23,42,0.18)",
    };
  }
  if (avgBrightness > 200) {
    return {
      padding: 12,
      background:
        "linear-gradient(135deg, rgba(15,23,42,0.9), rgba(30,41,59,0.75))",
      border: "1px solid rgba(15,23,42,0.32)",
      boxShadow: "0 4px 18px rgba(15,23,42,0.3)",
    };
  }
  return {
    padding: 12,
    background:
      "linear-gradient(135deg, rgba(240,244,255,0.95), rgba(226,232,240,0.75))",
    border: "1px solid rgba(15,23,42,0.14)",
    boxShadow: "0 4px 16px rgba(15,23,42,0.2)",
  };
};

// ---------- Gauge utils ----------

// --- Color utils (HSL) ---
const hsl = (h: number, s = 72, l = 45) => `hsl(${Math.round(h)} ${s}% ${l}%)`;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Beta legend: <1 stays blue->green, 1 stays green, >1 shifts toward red
function betaValueColor(value: number, min: number, max: number) {
  const target = 1;
  const belowT = clamp01((value - min) / Math.max(0.0001, target - min)); // [min..1] -> [0..1]
  const aboveT = clamp01((value - target) / Math.max(0.0001, max - target)); // [1..max] -> [0..1]
  // Hue ramp: blue~215deg -> green~135deg -> red~0deg
  if (value <= target) return hsl(lerp(215, 135, belowT));
  return hsl(lerp(135, 0, aboveT));
}

// Analyst recommendation (1 strong buy to 5 strong sell) maps to green->red
function recommendationValueColor(value: number) {
  const t = clamp01((value - 1) / 4); // [1..5] -> [0..1]
  return hsl(lerp(135, 0, t)); // green ~135deg -> red ~0deg
}

/** Semi-circle gauge with a needle, a 1.0 marker, and arc labels */
function GaugeBetaNeedle({
  value,
  min,
  max,
  label,
  valueColor,
}: {
  value: number;
  min: number;
  max: number;
  color?: string;
  label?: string;
  valueColor?: string;
}) {
  // ===== Visual settings =====

  // 1) Arc configuration (must match the <Pie> below)
  const ARC = {
    innerPct: 0.68, // inner radius (innerRadius="68%")
    outerPct: 1, // outer radius (outerRadius="86%")
    cyRatio: 0.65, // vertical center position (0=top, 1=bottom)
  };

  // 2) Needle
  const NEEDLE = {
    lengthRatio: 0.44, // relative length (0..1)
    stroke: 3, // stroke width
    hub: 4, // pivot radius
    color: "#334155", // stroke color
  };

  // 3) Marker for value "1"
  const ONE_MARKER = {
    TIE_TO_ARC: false, // true sticks to the ring; false allows custom radii
    startRatio: 0.33, // start radius when not tied to the arc
    endRatio: 0.5, // end radius when not tied to the arc
    stroke: 2, // stroke width
    color: "#0f172a",
    cap: "round" as const,
    labelOffset: 14, // distance in px between the "1" label and the arc
    labelFont: 12, // font size (px) for the "1" label
  };

  // 4) Labels along the arc (min and max)
  const TICKS = {
    offset: 10, // spacing in px between the labels and the arc
    font: 12, // font size (px) for the labels
  };

  // 5) Center value label (e.g. 1.25)
  const VALUE_LABEL = {
    topPct: 0.75, // vertical placement for the value (0=top, 1=bottom)
    font: 20, // font size (px)
  };

  const HEIGHT = 200; // component height

  // ====== Calculations ======
  const span = Math.max(0.0001, max - min);
  const v = Math.max(min, Math.min(max, value));
  const pct = (v - min) / span;

  const START = 180;
  const END = 0;

  // Gradient: blue -> green -> red
  const gradientId = "betaGradient";
  const gradient = (
    <defs>
      <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#1d4ed8" />
        <stop offset="50%" stopColor="#16a34a" />
        <stop offset="100%" stopColor="#dc2626" />
      </linearGradient>
    </defs>
  );

  const trackData = [{ name: "track", val: span }];

  // Measure container bounds so the overlay SVG always matches the Pie layout
  const theta = Math.PI * (1 - pct);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setBox({ w: width, h: height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const base = Math.min(box.w, box.h);
  const cx = box.w / 2;
  const cy = box.h * ARC.cyRatio;

  // Needle vector used for the overlay SVG
  const needleR = base * NEEDLE.lengthRatio; // needle length in px
  const x2 = cx + needleR * Math.cos(theta);
  const y2 = cy - needleR * Math.sin(theta);

  // Reference marker for value 1
  const stdPct = (1 - min) / span;
  const stdTheta = Math.PI * (1 - stdPct);

  // Radii for the marker when it is tied to the arc or free-floating
  const markerInnerR = ONE_MARKER.TIE_TO_ARC
    ? base * (ARC.innerPct / 2)
    : base * ONE_MARKER.startRatio;
  const markerOuterR = ONE_MARKER.TIE_TO_ARC
    ? base * (ARC.outerPct / 2)
    : base * ONE_MARKER.endRatio;

  // Coordinates for the "1" marker line
  const xStdIn = cx + markerInnerR * Math.cos(stdTheta);
  const yStdIn = cy - markerInnerR * Math.sin(stdTheta);
  const xStdOut = cx + markerOuterR * Math.cos(stdTheta);
  const yStdOut = cy - markerOuterR * Math.sin(stdTheta);

  // Position of the small "1" label just beyond the arc
  const oneLabelR = markerOuterR + ONE_MARKER.labelOffset;
  const xOne = cx + oneLabelR * Math.cos(stdTheta);
  const yOne = cy - oneLabelR * Math.sin(stdTheta);

  // Positions for the min/max labels anchored to the arc
  const outerR = base * (ARC.outerPct / 2);
  const tickR = outerR + TICKS.offset;

  const xMin = cx + tickR * Math.cos(Math.PI); // left edge of the arc
  const yMin = cy - tickR * Math.sin(Math.PI);

  const xMax = cx + tickR * Math.cos(0); // right edge of the arc
  const yMax = cy - tickR * Math.sin(0);

  return (
    <div
      className="gauge-wrapper"
      style={{ width: "100%", height: HEIGHT, position: "relative" }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          {gradient}
          <Pie
            data={trackData}
            dataKey="val"
            startAngle={START}
            endAngle={END}
            cx="50%"
            cy={`${ARC.cyRatio * 100}%`}
            innerRadius={`${ARC.innerPct * 100}%`}
            outerRadius={`${ARC.outerPct * 100}%`}
            stroke="none"
            isAnimationActive={false}
            fill={`url(#${gradientId})`}
          />
        </PieChart>
      </ResponsiveContainer>

      {/* Overlay: needle + reference + arc labels */}
      <div
        ref={ref}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        {box.w > 0 && (
          <svg width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`}>
            {/* Needle */}
            <line
              x1={cx}
              y1={cy}
              x2={x2}
              y2={y2}
              stroke={NEEDLE.color}
              strokeWidth={NEEDLE.stroke}
            />
            <circle cx={cx} cy={cy} r={NEEDLE.hub} fill={NEEDLE.color} />

            {/* Radial marker at 1 */}
            <line
              x1={xStdIn}
              y1={yStdIn}
              x2={xStdOut}
              y2={yStdOut}
              stroke={ONE_MARKER.color}
              strokeWidth={ONE_MARKER.stroke}
              strokeLinecap={ONE_MARKER.cap}
            />
            {/* Small "1" label beside the marker */}
            <text
              x={xOne}
              y={yOne}
              fontSize={ONE_MARKER.labelFont}
              fill="#334155"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontWeight: 600 }}
            >
              1
            </text>

            {/* Min/Max labels hugging the arc */}
            <text
              x={xMin}
              y={yMin}
              fontSize={TICKS.font}
              fill="#475569"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {min}
            </text>
            <text
              x={xMax}
              y={yMax}
              fontSize={TICKS.font}
              fill="#475569"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {max}
            </text>
          </svg>
        )}
      </div>

      {/* Center value anchored by VALUE_LABEL.topPct */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: `${VALUE_LABEL.topPct * 100}%`, // adjust this to move the value up or down
          transform: "translate(-50%, -50%)",
          fontSize: VALUE_LABEL.font,
          fontWeight: 800,
          color: valueColor ?? "var(--primary-700)",
          textAlign: "center",
        }}
      >
        {label ?? v.toFixed(2)}
      </div>
    </div>
  );
}

/**
 * Generic needle gauge that supports both beta-style and recommendation-style
 * gradients. Handles masking, optional reference ticks, and min/max labels.
 */
function GaugeNeedle({
  value,
  min,
  max,
  label,
  valueColor,
  gradient = "beta",
  customStops,
  fillToNeedle = false,
  showStandardTick = false,
  standardValue = 1,
}: {
  value: number;
  min: number;
  max: number;
  label?: string;
  valueColor?: string;
  gradient?: "beta" | "reco";
  customStops?: Array<{ offset: number; color: string }>;
  fillToNeedle?: boolean;
  showStandardTick?: boolean;
  standardValue?: number;
}) {
  // Shared visual settings to stay consistent with the beta gauge
  const ARC = { innerPct: 0.68, outerPct: 1.0, cyRatio: 0.65 };
  const NEEDLE = { lengthRatio: 0.44, stroke: 3, hub: 4, color: "#334155" };
  const TICKS = { offset: 10, font: 12 };
  const VALUE_LABEL = { topPct: 0.75, font: 20 };
  const TRACK_COLOR = "rgba(148,163,184,0.18)"; // light neutral background track
  const HEIGHT = 160;

  // Normalize the incoming value to a 0..1 ratio within the provided bounds
  const span = Math.max(0.0001, max - min);
  const v = Math.max(min, Math.min(max, value));
  const pct = (v - min) / span;

  // Sweep from the left semicircle (180deg) to the right (0deg)
  const START = 180;
  const END = 0;

  // Needle angle expressed in degrees so Recharts can reuse it directly
  const needleAngle = START + pct * (END - START); // linear across the 180-degree sweep

  // Gradient definitions
  const gradId = useMemo(
    () => `gn-grad-${Math.random().toString(36).slice(2)}`,
    [],
  );
  const defaultStops =
    gradient === "beta"
      ? [
          { offset: 0, color: "#1d4ed8" }, // blue
          { offset: 50, color: "#16a34a" }, // green
          { offset: 100, color: "#dc2626" }, // red
        ]
      : [
          { offset: 0, color: "#16a34a" }, // green
          { offset: 50, color: "#f59e0b" }, // amber
          { offset: 100, color: "#dc2626" }, // red
        ];
  const stops = customStops ?? defaultStops;

  const gradientSvg = (
    <defs>
      <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
        {stops.map((s, i) => (
          <stop key={i} offset={`${s.offset}%`} stopColor={s.color} />
        ))}
      </linearGradient>
    </defs>
  );

  // Full dataset used to draw the entire arc
  const trackData = [{ name: "track", val: 1 }];

  // Overlay (needle + labels)
  const [box, setBox] = useState({ w: 0, h: 0 });
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setBox({ w: width, h: height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const cx = box.w / 2;
  const cy = box.h * ARC.cyRatio;
  const base = Math.min(box.w, box.h);

  // Needle orientation for the overlay SVG
  const theta = (needleAngle * Math.PI) / 180;
  const needleR = base * NEEDLE.lengthRatio;
  const x2 = cx + needleR * Math.cos(theta);
  const y2 = cy - needleR * Math.sin(theta);

  // Min/max labels anchored to the arc
  const outerR = base * (ARC.outerPct / 2);
  const tickR = outerR + TICKS.offset;
  const xMin = cx + tickR * Math.cos(Math.PI);
  const yMin = cy - tickR * Math.sin(Math.PI);
  const xMax = cx + tickR * Math.cos(0);
  const yMax = cy - tickR * Math.sin(0);

  // Reference tick (e.g., 1 for beta)
  const stdPct = (standardValue - min) / span;
  const stdTheta = Math.PI * (1 - stdPct);
  const markerInnerR = base * (ARC.innerPct / 2);
  const markerOuterR = base * (ARC.outerPct / 2);
  const xStdIn = cx + markerInnerR * Math.cos(stdTheta);
  const yStdIn = cy - markerInnerR * Math.sin(stdTheta);
  const xStdOut = cx + markerOuterR * Math.cos(stdTheta);
  const yStdOut = cy - markerOuterR * Math.sin(stdTheta);

  return (
    <div style={{ width: "100%", height: HEIGHT, position: "relative" }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          {gradientSvg}

          {/* 1) neutral track spanning the complete arc */}
          <Pie
            data={trackData}
            dataKey="val"
            startAngle={START}
            endAngle={END}
            cx="50%"
            cy={`${ARC.cyRatio * 100}%`}
            innerRadius={`${ARC.innerPct * 100}%`}
            outerRadius={`${ARC.outerPct * 100}%`}
            isAnimationActive={false}
            stroke="none"
            fill={TRACK_COLOR}
          />

          {/* 2) gradient painted across the full arc */}
          <Pie
            data={trackData}
            dataKey="val"
            startAngle={START}
            endAngle={END}
            cx="50%"
            cy={`${ARC.cyRatio * 100}%`}
            innerRadius={`${ARC.innerPct * 100}%`}
            outerRadius={`${ARC.outerPct * 100}%`}
            isAnimationActive={false}
            stroke="none"
            fill={`url(#${gradId})`}
          />

          {/* 3) optional mask to hide the gradient after the needle */}
          {fillToNeedle && (
            <Pie
              data={trackData}
              dataKey="val"
              startAngle={needleAngle}
              endAngle={END}
              cx="50%"
              cy={`${ARC.cyRatio * 100}%`}
              innerRadius={`${ARC.innerPct * 100}%`}
              outerRadius={`${ARC.outerPct * 100}%`}
              isAnimationActive={false}
              fill="rgba(148,163,184)" // translucent neutral gray
              stroke="rgba(148,163,184)"
            />
          )}
        </PieChart>
      </ResponsiveContainer>

      {/* Overlay: needle + reference + arc labels */}
      <div
        ref={ref}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        {box.w > 0 && (
          <svg width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`}>
            {/* Needle */}
            <line
              x1={cx}
              y1={cy}
              x2={x2}
              y2={y2}
              stroke={NEEDLE.color}
              strokeWidth={NEEDLE.stroke}
            />
            <circle cx={cx} cy={cy} r={NEEDLE.hub} fill={NEEDLE.color} />

            {/* Optional reference tick */}
            {showStandardTick && (
              <>
                <line
                  x1={xStdIn}
                  y1={yStdIn}
                  x2={xStdOut}
                  y2={yStdOut}
                  stroke="#0f172a"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
                <text
                  x={cx + (markerOuterR + 12) * Math.cos(stdTheta)}
                  y={cy - (markerOuterR + 12) * Math.sin(stdTheta)}
                  fontSize={12}
                  fill="#334155"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{ fontWeight: 600 }}
                >
                  {standardValue}
                </text>
              </>
            )}

            {/* Min/Max labels at the arc boundaries */}
            <text
              x={xMin}
              y={yMin}
              fontSize={TICKS.font}
              fill="#475569"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {min}
            </text>
            <text
              x={xMax}
              y={yMax}
              fontSize={TICKS.font}
              fill="#475569"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {max}
            </text>
          </svg>
        )}
      </div>

      {/* Center value */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: `${VALUE_LABEL.topPct * 100}%`,
          transform: "translate(-50%, -50%)",
          fontSize: VALUE_LABEL.font,
          fontWeight: 800,
          color: valueColor ?? "var(--primary-700)",
          pointerEvents: "none",
          textAlign: "center",
        }}
      >
        {label ?? v.toFixed(2)}
      </div>
    </div>
  );
}

/**
 * Lightweight buy/sell form embedded in the Explore header.
 * Disables actions automatically when the user lacks cash or holdings.
 */
function QuickTrade({ symbol }: { symbol: string }) {
  const uid = auth.currentUser!.uid;
  const { t } = useI18n();
  const { cash, positions } = usePortfolioSnapshot(uid);
  const [qty, setQty] = useState(1);
  const posQty = positions[symbol]?.qty ?? 0;
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fetched = await provider.getLastPrice(symbol);
        if (cancelled) return;
        setLastPrice(Number.isFinite(fetched) && fetched > 0 ? fetched : null);
      } catch {
        if (!cancelled) setLastPrice(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const numericQty = Number.isFinite(qty) ? Math.max(0, qty) : 0;
  const estimatedCost =
    lastPrice && numericQty > 0 ? numericQty * lastPrice : null;
  const insufficientCash =
    typeof estimatedCost === "number" ? cash + 1e-6 < estimatedCost : false;
  const buyDisabled = loading || numericQty <= 0 || insufficientCash;
  const sellDisabled =
    loading || numericQty <= 0 || posQty <= 0 || posQty + 1e-9 < numericQty;

  const place = async (side: "buy" | "sell") => {
    setMsg(null);
    setLoading(true);
    try {
      const px = await provider.getLastPrice(symbol);
      if (!Number.isFinite(px) || px <= 0) {
        setMsg({ text: t("quicktrade.error.invalidPrice"), tone: "error" });
        return;
      }
      const q = Math.max(0, Number(qty) || 0);
      if (!q) {
        setMsg({ text: t("quicktrade.error.invalidQuantity"), tone: "error" });
        return;
      }
      if (side === "sell" && posQty < q - 1e-9) {
        setMsg({
          text: t("quicktrade.error.insufficientPosition"),
          tone: "error",
        });
        return;
      }
      if (side === "buy" && cash + 1e-6 < q * px) {
        setMsg({ text: t("quicktrade.error.insufficientCash"), tone: "error" });
        return;
      }

      await submitSpotOrder({
        uid,
        symbol,
        side,
        qty: q,
        fillPrice: px,
        extra: { source: "QuickTrade" },
      });

      setMsg({
        text:
          side === "buy"
            ? t("quicktrade.success.buy")
            : t("quicktrade.success.sell"),
        tone: "success",
      });
    } catch (e: any) {
      setMsg({ text: e?.message ?? String(e), tone: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="quicktrade">
      <div className="quicktrade-controls">
        <span className="quicktrade-owned">
          {t("quicktrade.label.owned", { amount: posQty })}
        </span>
        <input
          className="quicktrade-input input"
          type="number"
          min={0}
          step="any"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
        />
        <button
          className="btn btn-accent quicktrade-action"
          disabled={buyDisabled}
          onClick={() => place("buy")}
        >
          {t("quicktrade.actions.buy")}
        </button>
        <button
          className="btn btn-sell quicktrade-action"
          disabled={sellDisabled}
          onClick={() => place("sell")}
        >
          {t("quicktrade.actions.sell")}
        </button>
      </div>
      {msg && (
        <div
          className={`quicktrade-msg ${msg.tone === "error" ? "is-error" : "is-success"}`}
          role={msg.tone === "error" ? "alert" : "status"}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

/**
 * Main Explore page: hosts the sidebar, header summary, quick trade,
 * charts, and insight panels for the currently selected symbol.
 */
export default function Explore() {
  const { t } = useI18n();
  const [symbol, setSymbol] = useState<string>("AAPL");
  const [tf, setTf] = useState<TF | null>("6M");
  const [data, setData] = useState<OHLC[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [focusSidebarOnOpen, setFocusSidebarOnOpen] = useState(false);
  const reopenButtonRef = useRef<HTMLButtonElement | null>(null);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const suppressRangeUpdateRef = useRef<boolean>(false);
  const lastIndexRef = useRef(0);
  const firstIndexRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idx = await fetchCompaniesIndex();
        if (cancelled) return;
        setCompanies(idx);
      } catch {
        // Ignore network errors for now; UI will simply show an empty list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!companies.length) return;
    if (companies.some((c) => c.symbol === symbol)) return;

    const firstUS = companies.find(
      (c) => (c.market || "").toUpperCase() === "US",
    );
    const fallback = firstUS?.symbol ?? companies[0]?.symbol;
    if (fallback) setSymbol(fallback);
  }, [companies, symbol]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hist = await provider.getDailyHistory(symbol);
        if (!cancelled) setData(hist);
      } catch {
        if (!cancelled) setData([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);
  const selectedCompany = useMemo(
    () => companies.find((c) => c.symbol === symbol) ?? null,
    [companies, symbol],
  );

  useEffect(() => {
    const company = selectedCompany;
    if (!company) {
      setProfile(null);
      return;
    }

    let cancelled = false;

    (async () => {
      // Call into the shared centralized service
      const profileData = await fetchCompanyProfile(company.symbol);

      if (!cancelled) {
        if (profileData) {
          setProfile(profileData);
        } else {
          // Fallback simple : on affiche ce qu'on a dans la liste
          setProfile({
            ...company,
            displayName: company.name,
            sectorDisplay: company.sector,
            industryDisp: company.industry ?? undefined,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedCompany]);

  const dateBounds = useMemo(() => {
    if (!data.length) return null;
    const firstDate = new Date(data[0].date);
    firstDate.setHours(0, 0, 0, 0);

    // Shift the left bound slightly to avoid hugging the edge
    const min = shiftDays(firstDate, -30);
    min.setHours(0, 0, 0, 0);

    // Right bound = most recent candle date (never "today")
    const lastDate = new Date(data[data.length - 1].date);
    lastDate.setHours(0, 0, 0, 0);

    return { min, max: lastDate };
  }, [data]);

  const setVisibleRangeClamped = useCallback(
    (fromDate: Date, toDate: Date) => {
      if (!chartRef.current) return;
      const timeScale = chartRef.current.timeScale();
      let rangeStart = new Date(fromDate);
      let rangeEnd = new Date(toDate);
      if (rangeStart.getTime() > rangeEnd.getTime()) {
        const temp = rangeStart;
        rangeStart = rangeEnd;
        rangeEnd = temp;
      }
      if (dateBounds) {
        const clamped = clampDateRange(rangeStart, rangeEnd, dateBounds);
        rangeStart = clamped.from;
        rangeEnd = clamped.to;
      }
      suppressRangeUpdateRef.current = true;
      timeScale.setVisibleRange({
        from: toBusinessDay(rangeStart),
        to: toBusinessDay(rangeEnd),
      });
      const release = () => {
        suppressRangeUpdateRef.current = false;
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(release);
      } else {
        setTimeout(release, 0);
      }
    },
    [dateBounds],
  );

  const applyTimeframeRange = useCallback(
    (timeframe: TF) => {
      if (!data.length) return;
      if (data.length < 2) {
        chartRef.current?.timeScale().fitContent();
        return;
      }
      const lastEntry = data[data.length - 1];
      const lastDate = new Date(lastEntry.date);
      let fromDate = new Date(data[0].date);
      const currentYearStart = new Date(new Date().getFullYear(), 0, 1);

      if (timeframe === "1M") {
        fromDate = shiftDays(lastDate, -30);
      } else if (timeframe === "6M") {
        fromDate = shiftDays(lastDate, -182);
      } else if (timeframe === "1Y") {
        fromDate = shiftDays(lastDate, -365);
      } else if (timeframe === "YTD") {
        fromDate = currentYearStart;
      } else if (timeframe === "MAX") {
        if (dateBounds) {
          setVisibleRangeClamped(dateBounds.min, dateBounds.max);
        } else {
          setVisibleRangeClamped(new Date(data[0].date), lastDate);
        }
        return;
      }

      setVisibleRangeClamped(fromDate, lastDate);
    },
    [data, dateBounds, setVisibleRangeClamped],
  );

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const element = chartContainerRef.current;

    const chart = createChart(element, {
      width: element.clientWidth,
      height: element.clientHeight,
      layout: {
        background: { color: "transparent" },
        textColor: "#0f172a",
      },
      grid: {
        vertLines: { color: "rgba(15,23,42,0.08)" },
        horzLines: { color: "rgba(15,23,42,0.05)" },
      },
      rightPriceScale: {
        borderColor: "rgba(15,23,42,0.08)",
      },
      timeScale: {
        borderColor: "rgba(15,23,42,0.08)",
      },
      crosshair: {
        mode: 1,
      },
    });

    // v3 officiel : addCandlestickSeries
    const series = chart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#dc2626",
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      chart.resize(width, height);
    });
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const formatted: CandlestickData[] = data.map((d) => ({
      time: d.date as Time,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
    }));
    seriesRef.current.setData(formatted);
    firstIndexRef.current = 0;
    lastIndexRef.current = formatted.length ? formatted.length - 1 : 0;
  }, [data]);

  useEffect(() => {
    if (tf) applyTimeframeRange(tf);
  }, [tf, applyTimeframeRange]);

  useEffect(() => {
    if (!chartRef.current) return;
    const timeScale = chartRef.current.timeScale();

    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;

      // 1) User pan/zoom deselects the preset buttons
      if (!suppressRangeUpdateRef.current) {
        if (tf !== null) setTf(null);
      }

      // 2) Clamp blank space on both sides to at most 15% of the viewport
      const span = range.to - range.from;
      if (!Number.isFinite(span) || span <= 0) return;

      const first = firstIndexRef.current; // en pratique 0
      const last = lastIndexRef.current;

      // Logical bounds
      const minFrom = first - span * 0.15; // <= 15% white space on the left
      const maxTo = last + span * 0.15; // <= 15% white space on the right

      let newFrom = range.from;
      let newTo = range.to;

      // Clamp left
      if (newFrom < minFrom) {
        newFrom = minFrom;
        newTo = newFrom + span;
      }

      // Clamp right
      if (newTo > maxTo) {
        newTo = maxTo;
        newFrom = newTo - span;
      }

      // Nothing changed, exit early
      if (newFrom === range.from && newTo === range.to) return;

      suppressRangeUpdateRef.current = true;
      timeScale.setVisibleLogicalRange({ from: newFrom, to: newTo });

      // Release the guard flag on the next frame
      (typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (fn: FrameRequestCallback) => setTimeout(fn, 0))(() => {
        suppressRangeUpdateRef.current = false;
      });
    };

    timeScale.subscribeVisibleLogicalRangeChange(handler);
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [tf]);

  const lastClose = data.at(-1)?.close ?? 0;
  const lastCloseLabel = data.length ? lastClose.toFixed(2) : "--";
  const lastPriceDate = data.at(-1)?.date;

  const displayName = profile?.displayName ?? selectedCompany?.name ?? symbol;
  const longNameSuffix = undefined;
  const subtitleParts: string[] = [symbol];
  if (profile?.sectorDisplay) {
    subtitleParts.push(profile.sectorDisplay);
  } else if (profile?.sector) {
    subtitleParts.push(profile.sector);
  } else if (profile?.industryDisp) {
    subtitleParts.push(profile.industryDisp);
  } else if (selectedCompany?.sector) {
    subtitleParts.push(selectedCompany.sector);
  } else if (selectedCompany?.name) {
    subtitleParts.push(selectedCompany.name);
  }
  const subtitle = subtitleParts.join(" - ");

  const ensureProtocol = (url: string) =>
    /^https?:/i.test(url) ? url : `https://${url}`;

  const insights = useMemo(() => {
    if (!profile) return { gauges: [], ranges: [], metrics: [] };
    const gauges: InsightItem[] = [];
    const ranges: RangeItem[] = [];
    const metrics: MetricRow[] = [];
    type Key = Parameters<typeof t>[0];

    if (profile.beta !== undefined && profile.beta !== null) {
      const betaValue = profile.beta;
      const betaMin = Math.min(-1, Math.floor(betaValue - 1));
      const betaMax = Math.max(3, Math.ceil(betaValue + 1));

      gauges.push({
        key: "beta",
        label: t("explore.metrics.beta"),
        description: t("explore.metrics.beta.help"),
        gauge: {
          value: betaValue,
          min: betaMin,
          max: betaMax,
          target: 1,
          format: (val) => val.toFixed(2),
        },
      });
    }

    if (
      profile.recommendationMean !== undefined &&
      profile.recommendationMean !== null
    ) {
      gauges.push({
        key: "recommendation",
        label: t("explore.metrics.recommendationMean"),
        description: t("explore.metrics.recommendationMean.help"),
        gauge: {
          value: profile.recommendationMean,
          min: 1,
          max: 5,
          format: (val) => val.toFixed(1),
        },
      });
    }

    const addNumberMetric = (
      key: string,
      labelKey: Key,
      value: number | undefined | null,
      formatter: (value: number) => ReactNode,
    ) => {
      if (value == null) return;
      metrics.push({
        key,
        label: t(labelKey),
        value: formatter(value),
      });
    };

    const addCurrencyMetric = (
      key: string,
      labelKey: Key,
      value: number | undefined | null,
    ) => {
      if (value == null) return;
      metrics.push({
        key,
        label: t(labelKey),
        value: (
          <div className="metric-stack">
            <span className="metric-main">{formatCompactUSD(value)}</span>
            <span className="metric-sub">{formatUSD(value)}</span>
          </div>
        ),
      });
    };

    const addRange = (
      key: string,
      labelKey: Key,
      min: number | undefined | null,
      max: number | undefined | null,
      helpKey?: Key,
      current?: number,
      minDate?: string,
      maxDate?: string,
      currentDate?: string,
    ) => {
      if (min == null || max == null) return;

      ranges.push({
        key,
        label: t(labelKey),
        description: helpKey ? t(helpKey) : undefined,
        low: min,
        high: max,
        current: current ?? lastClose,
        lowDate: minDate,
        highDate: maxDate,
        currentDate,
        lowLabel: t("explore.metrics.range.low"),
        highLabel: t("explore.metrics.range.high"),
        currentLabel: t("explore.metrics.range.current"),
      });
    };

    addNumberMetric(
      "trailingPE",
      "explore.metrics.trailingPE",
      profile.trailingPE,
      (value) => formatNumberValue(value, 2),
    );
    addNumberMetric(
      "trailingEPS",
      "explore.metrics.trailingEPS",
      profile.trailingEPS,
      (value) => formatNumberValue(value, 2),
    );

    addCurrencyMetric(
      "marketCap",
      "explore.metrics.marketCap",
      profile.marketCap,
    );

    addCurrencyMetric(
      "totalRevenue",
      "explore.metrics.totalRevenue",
      profile.totalRevenue,
    );
    addCurrencyMetric(
      "totalDebt",
      "explore.metrics.totalDebt",
      profile.totalDebt,
    );
    addCurrencyMetric(
      "totalCash",
      "explore.metrics.totalCash",
      profile.totalCash,
    );
    addCurrencyMetric(
      "freeCashflow",
      "explore.metrics.freeCashflow",
      profile.freeCashflow,
    );
    addCurrencyMetric(
      "operatingCashflow",
      "explore.metrics.operatingCashflow",
      profile.operatingCashflow,
    );

    addRange(
      "fiftyTwoWeeksRange",
      "explore.metrics.fiftyTwoWeeksRange",
      profile.fiftyTwoWeeksLow,
      profile.fiftyTwoWeeksHigh,
      "explore.metrics.fiftyTwoWeeksRange.help",
      lastClose,
      undefined,
      undefined,
      lastPriceDate ?? undefined,
    );

    addRange(
      "allTimeRange",
      "explore.metrics.allTimeRange",
      profile.allTimeLow,
      profile.allTimeHigh,
      "explore.metrics.allTimeRange.help",
      lastClose,
      undefined,
      undefined,
      lastPriceDate ?? undefined,
    );

    return { gauges, ranges, metrics };
  }, [profile, t, lastClose, lastPriceDate]);
  const { gauges, ranges, metrics } = insights;

  const headerMeta = useMemo(() => {
    if (!profile) return [];
    const items: { key: string; label: string; value: ReactNode }[] = [];

    if (profile.sectorDisplay || profile.sector) {
      items.push({
        key: "sector",
        label: t("explore.metrics.sectorDisplay"),
        value: profile.sectorDisplay ?? profile.sector ?? "",
      });
    }

    if (profile.industryDisp) {
      items.push({
        key: "industry",
        label: t("explore.metrics.industry"),
        value: profile.industryDisp,
      });
    }

    if (profile.website) {
      const href = ensureProtocol(profile.website);
      const label = profile.website.replace(/^https?:\/\//i, "");
      items.push({
        key: "website",
        label: t("explore.metrics.website"),
        value: (
          <a href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ),
      });
    }

    if (profile.irWebsite) {
      const href = ensureProtocol(profile.irWebsite);
      const label = profile.irWebsite.replace(/^https?:\/\//i, "");
      items.push({
        key: "irWebsite",
        label: t("explore.metrics.irWebsite"),
        value: (
          <a href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ),
      });
    }

    return items;
  }, [profile, t]);

  const placeholderLogo = assetPath("img/logo-placeholder.svg");

  const headerLogo = selectedCompany?.logo
    ? assetPath(selectedCompany.logo)
    : placeholderLogo;
  const [logoStyle, setLogoStyle] = useState<CSSProperties>(DEFAULT_LOGO_STYLE);

  useEffect(() => {
    let cancelled = false;
    if (!selectedCompany?.logo) {
      setLogoStyle(DEFAULT_LOGO_STYLE);
      return () => {
        cancelled = true;
      };
    }
    setLogoStyle(DEFAULT_LOGO_STYLE);
    analyzeLogoAppearance(headerLogo)
      .then((style) => {
        if (!cancelled) setLogoStyle(style);
      })
      .catch(() => {
        if (!cancelled) setLogoStyle(DEFAULT_LOGO_STYLE);
      });

    return () => {
      cancelled = true;
    };
  }, [headerLogo, selectedCompany?.logo]);

  useEffect(() => {
    if (!sidebarOpen) {
      const frame = requestAnimationFrame(() => {
        reopenButtonRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [sidebarOpen]);

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

  const handleSelectSymbol = useCallback(
    (next: string) => {
      setSymbol(next);
      if (!sidebarOpen) {
        setSidebarOpen(true);
        setFocusSidebarOnOpen(true);
      }
    },
    [sidebarOpen],
  );

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
          placeholderLogoPath="img/logo-placeholder.svg"
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
          <div className="explore-main-content">
            <div className="explore-content-shell">
              <div className="explore-header">
                <div className="explore-header-top">
                  <div className="company-identity">
                    <img
                      src={headerLogo}
                      alt={`${selectedCompany?.name ?? symbol} logo`}
                      className="company-logo"
                      style={logoStyle}
                    />
                    <div>
                      <h1>
                        {displayName}
                        {longNameSuffix && (
                          <span className="company-alias">
                            <span
                              aria-hidden="true"
                              className="company-alias-separator"
                            >
                              {"\u00b7"}
                            </span>
                            <span>{longNameSuffix}</span>
                          </span>
                        )}
                      </h1>
                      <p>{subtitle}</p>
                    </div>
                  </div>
                  <QuickTrade symbol={symbol} />
                </div>
                {profile?.longBusinessSummary && (
                  <ExpandableSummary text={profile.longBusinessSummary} t={t} />
                )}
                {headerMeta.length > 0 && (
                  <dl className="company-meta">
                    {headerMeta.map((item) => (
                      <div key={item.key} className="company-meta-item">
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>

              <div className="chart-card">
                <div className="chart-overlay">
                  <div className="chart-last">
                    {t("explore.lastLabel")} <strong>{lastCloseLabel}</strong>
                  </div>
                  <div
                    className="timeframe-group"
                    role="group"
                    aria-label={t("explore.timeframe.label")}
                  >
                    {["1M", "6M", "YTD", "1Y", "MAX"].map((x) => (
                      <button
                        key={x}
                        type="button"
                        className={
                          tf === x ? "timeframe-btn active" : "timeframe-btn"
                        }
                        onClick={() => setTf(x as TF)}
                        aria-pressed={tf === x}
                      >
                        {x}
                      </button>
                    ))}
                  </div>
                </div>
                <div ref={chartContainerRef} className="chart-container" />
              </div>
              {(gauges.length > 0 ||
                ranges.length > 0 ||
                metrics.length > 0) && (
                <section className="explore-insights">
                  {/* PERFORMANCE */}
                  {ranges.length > 0 && (
                    <div className="insight-panel">
                      <div className="insight-panel-head">
                        <h3 className="insight-panel-title">
                          {t("explore.metrics.performanceTitle") ??
                            "Performance"}
                        </h3>
                        <p className="insight-panel-desc">
                        {t("explore.metrics.performanceDesc") ??
                          "Price evolution over 52 weeks and across the full history."}
                        </p>
                      </div>

                      <div className="insight-panel-body insight-panel-body--grid">
                        {ranges.map((range) => {
                          const tooltipId = `range-${range.key}-tooltip`;
                          const tooltipLabel = range.description
                            ? `${range.label}: ${range.description}`
                            : range.label;
                          return (
                            <div key={range.key} className="insight-subcard">
                              <div className="insight-subcard-head">
                                <span className="label">{range.label}</span>
                                {range.description && (
                                  <span className="info-tooltip">
                                    <button
                                      type="button"
                                      className="info-btn"
                                      title={range.description}
                                      aria-label={tooltipLabel}
                                      aria-describedby={
                                        range.description
                                          ? tooltipId
                                          : undefined
                                      }
                                    >
                                      i
                                    </button>
                                    <span
                                      id={tooltipId}
                                      role="tooltip"
                                      className="info-tooltip-content"
                                    >
                                      {range.description}
                                    </span>
                                  </span>
                                )}
                              </div>

                              <div className="insight-subcard-body range-body">
                                <RangeHistogram
                                  key={range.key}
                                  low={range.low}
                                  high={range.high}
                                  current={range.current}
                                  lowLabel={range.lowLabel}
                                  highLabel={range.highLabel}
                                  currentLabel={range.currentLabel}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* RISQUE & AVIS */}
                  {gauges.length > 0 && (
                    <div className="insight-panel">
                      <div className="insight-panel-head">
                        <h3 className="insight-panel-title">
                          {t("explore.metrics.riskTitle") ??
                            "Risque & Avis analystes"}
                        </h3>
                        <p className="insight-panel-desc">
                          {t("explore.metrics.riskDesc") ??
                            "Volatility vs. the market and analyst consensus."}
                        </p>
                      </div>

                      <div className="insight-panel-body insight-panel-body--grid">
                        {gauges.map((item) => {
                          return (
                            <div key={item.key} className="insight-subcard">
                              <div className="insight-subcard-head">
                                <span className="label">{item.label}</span>
                                {item.description && (
                                  <span className="info-tooltip">
                                    <button
                                      type="button"
                                      className="info-btn"
                                      title={item.description}
                                      aria-label={`${item.label}: ${item.description}`}
                                    >
                                      i
                                    </button>
                                    <span
                                      role="tooltip"
                                      className="info-tooltip-content"
                                    >
                                      {item.description}
                                    </span>
                                  </span>
                                )}
                              </div>

                              <div className="insight-subcard-body gauge-body">
                                {item.key === "recommendation" && item.gauge ? (
                                  <GaugeNeedle
                                    value={item.gauge.value}
                                    min={item.gauge.min} // 1
                                    max={item.gauge.max} // 5
                                    label={item.gauge.format(item.gauge.value)}
                                    valueColor={recommendationValueColor(
                                      item.gauge.value,
                                    )}
                                    gradient="reco"
                                    fillToNeedle={true} // uniform gradient across the arc with masking past the needle
                                    showStandardTick={false} // hide the fixed tick
                                  />
                                ) : item.key === "beta" && item.gauge ? (
                                  <GaugeBetaNeedle
                                    value={item.gauge.value}
                                    // Keep the 0..3 bounds aligned with the primary gauge
                                    min={0}
                                    max={3}
                                    color="#d4b200"
                                    label={item.gauge.format(item.gauge.value)}
                                    valueColor={betaValueColor(
                                      item.gauge.value,
                                      0,
                                      3,
                                    )}
                                  />
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* FONDAMENTAUX */}
                  {metrics.length > 0 && (
                    <div className="insight-panel">
                      <div className="insight-panel-head">
                        <h3 className="insight-panel-title">
                          {t("explore.metrics.fundamentalsTitle") ??
                            "Fondamentaux"}
                        </h3>
                        <p className="insight-panel-desc">
                          {t("explore.metrics.fundamentalsDesc") ??
                            "Valuation, revenue, cash flow, and financial structure."}
                        </p>
                      </div>

                      <div className="insight-panel-body">
                        <div className="metrics-card">
                          <table className="metrics-table">
                            <tbody>
                              {metrics.map((row) => (
                                <tr key={row.key}>
                                  <th scope="row">{row.label}</th>
                                  <td>{row.value}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              )}
              <p className="hint explore-source">{t("explore.sourceHint")}</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
function shiftDays(d: Date, delta: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + delta);
  return x;
}

/**
 * Clamp a user-selected chart window so we never pan/zoom past the available
 * data while still allowing a small visual gutter around the latest candle.
 */
function clampDateRange(
  from: Date,
  to: Date,
  bounds: { min: Date; max: Date },
  rightGapFraction: number = 0.25, // allow up to 25% extra space beyond the last candle
): { from: Date; to: Date } {
  const minTs = bounds.min.getTime();
  const maxTs = bounds.max.getTime();

  let start = Math.min(from.getTime(), to.getTime());
  let end = Math.max(from.getTime(), to.getTime());

  // Minimum window width
  let span = Math.max(ONE_DAY_MS, end - start);

  // Cannot exceed the full range
  const totalSpan = Math.max(ONE_DAY_MS, maxTs - minTs);
  if (span > totalSpan) span = totalSpan;

  // Enforce the minimum (left) bound so we never scroll before the dataset begins
  if (start < minTs) {
    start = minTs;
    end = start + span;
  }

  // Right bound plus the tolerated 25% slack
  const maxWithGap = maxTs + Math.floor(span * rightGapFraction);
  if (end > maxWithGap) {
    end = maxWithGap;
    start = end - span;
  }

  // Final safety clamp
  if (start < minTs) start = minTs;
  if (end < start) end = start + span;

  return { from: new Date(start), to: new Date(end) };
}

// ===== Overlay that mirrors the real MUI scale =====

type RangeHistogramProps = {
  low: number;
  high: number;
  current: number;
  lowLabel?: string;
  highLabel?: string;
  currentLabel?: string;
};

/**
 * Simple two-column histogram that visualizes the low/high window plus the
 * current price marker, used for 52-week and lifetime performance blocks.
 */
function RangeHistogram({
  low,
  high,
  current,
  lowLabel,
  highLabel,
  currentLabel,
}: RangeHistogramProps) {
  // Data for the bars
  const data = [
    {
      label: lowLabel ?? "Low",
      lowVal: low,
      highVal: 0,
    },
    {
      label: highLabel ?? "High",
      lowVal: 0,
      highVal: high,
    },
  ];

  // Y bounds -> start at 0 and take the max of low/high/current
  const rawMax = Math.max(
    typeof low === "number" ? low : 0,
    typeof high === "number" ? high : 0,
    typeof current === "number" ? current : 0,
  );

  // Round the max upward to avoid awkward ticks such as 59.5799
  // Simple rule: use the next multiple of 10
  const yMaxNice = (() => {
    if (rawMax <= 0) return 10;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax))); // ordre de grandeur
    const step = magnitude / 2; // un pas raisonnable
    return Math.ceil(rawMax / step) * step;
  })();

  const fmtUSD = (n: number) =>
    n.toLocaleString("fr-FR", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });

  // Custom tooltip
  const currentLabelText = currentLabel ?? "Cours actuel";

  const renderCurrentLabel = useCallback(
    (labelProps: any) => {
      const viewBox = labelProps?.viewBox ?? {};
      const x = Number.isFinite(viewBox.x) ? viewBox.x : 0;
      const width = Number.isFinite(viewBox.width) ? viewBox.width : 0;
      const y = Number.isFinite(viewBox.y) ? viewBox.y : 0;

      const anchorX = x + width + 68;
      const baseY = y - 4;

      return (
        <g pointerEvents="none">
          <text
            x={anchorX}
            y={baseY}
            fontSize={10}
            fill="#64748b"
            fontWeight={600}
            textAnchor="end"
          >
            {currentLabelText}
          </text>
          <text
            x={anchorX}
            y={baseY + 14}
            fontSize={12}
            fill="#0f172a"
            fontWeight={700}
            textAnchor="end"
          >
            {fmtUSD(current)}
          </text>
        </g>
      );
    },
    [current, currentLabelText, fmtUSD],
  );

  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: any[];
    label?: string;
  }) => {
    if (!active || !payload || payload.length === 0) return null;

    const numericVals = payload
      .map((entry) => (typeof entry.value === "number" ? entry.value : NaN))
      .filter((v) => Number.isFinite(v)) as number[];

    if (numericVals.length === 0) return null;

    const nonZeroVals = numericVals.filter((v) => v !== 0);
    const chosenVal =
      nonZeroVals.length > 0
        ? Math.max(...nonZeroVals)
        : Math.max(...numericVals);

    return (
      <div
        style={{
          background: "rgba(255,255,255,0.9)",
          borderRadius: "6px",
          padding: "6px 8px",
          boxShadow: "0 4px 10px rgba(0,0,0,0.08)",
          border: "1px solid rgba(0,0,0,0.06)",
          fontSize: "0.75rem",
          lineHeight: 1.3,
          color: "#0f172a",
          fontWeight: 500,
        }}
      >
        <div style={{ color: "#475569", fontSize: "0.7rem" }}>{label}</div>
        <div style={{ fontWeight: 600 }}>{fmtUSD(chosenVal)}</div>
      </div>
    );
  };

  return (
    <div
      className="range-chart-wrapper"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <RBarChart
          data={data}
          margin={{ top: 10, right: 68, bottom: 0, left: 0 }}
          barCategoryGap="30%"
        >
          {/* Horizontal grid */}
          <CartesianGrid
            stroke="rgba(0,0,0,0.1)"
            strokeDasharray="3 3"
            vertical={false}
          />

          {/* Clean Y-axis formatting */}
          <YAxis
            domain={[0, yMaxNice]}
            width={32} // reduce the left gutter
            tickMargin={4} // keep a bit of air between ticks and the axis
            tickFormatter={(tick: number) => {
              if (Math.abs(tick) >= 10 || Number.isInteger(tick))
                return tick.toFixed(0);
              return tick.toFixed(1);
            }}
            tick={{ fontSize: 11, fill: "#475569" }}
            axisLine={{ stroke: "#0f172a", strokeWidth: 1 }}
            tickLine={false}
            padding={{ top: 5, bottom: 0 }}
          />

          {/* X-axis */}
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "#475569" }}
            axisLine={{ stroke: "#0f172a", strokeWidth: 1 }}
            tickLine={{ stroke: "#0f172a", strokeWidth: 1 }}
          />

          {/* Low bar rendered in red */}
          <Bar
            dataKey="lowVal"
            stackId="range"
            fill="#b91c1c"
            radius={[4, 4, 0, 0]}
            barSize={36} // optional fixed width
          />

          {/* High bar rendered in green */}
          <Bar
            dataKey="highVal"
            stackId="range"
            fill="#047857"
            radius={[4, 4, 0, 0]}
            barSize={36} // optional
          />

          {/* Dashed horizontal line and "Current price" bubble */}
          {/* Remove label=... from ReferenceLine to avoid clipped text */}
          <ReferenceLine
            y={current}
            stroke="#475569"
            strokeDasharray="4 4"
            strokeWidth={2}
            ifOverflow="extendDomain"
            label={renderCurrentLabel}
          />

          {/* Fixed tooltip */}
          <RTooltip
            content={<CustomTooltip />}
            cursor={{ fill: "rgba(0,0,0,0.03)" }}
          />
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}

const SUMMARY_WORD_LIMIT = 50;

function trimSummary(
  text: string,
  limit = SUMMARY_WORD_LIMIT,
): { preview: string; truncated: boolean } {
  const words = text.trim().split(/\s+/);
  if (words.length <= limit) {
    return { preview: text.trim(), truncated: false };
  }
  const preview = words.slice(0, limit).join(" ");
  return { preview: `${preview}...`, truncated: true };
}

function ExpandableSummary({
  text,
  t,
}: {
  text: string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [expanded, setExpanded] = useState(false);
  const { preview, truncated } = useMemo(() => trimSummary(text), [text]);
  if (!text.trim()) return null;

  return (
    <p className="company-summary">
      {expanded ? text : preview}
      {truncated && (
        <>
          {" "}
          <button
            type="button"
            className="summary-toggle"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded
              ? (t("explore.lessLabel") ?? "Less")
              : (t("explore.moreLabel") ?? "More")}
          </button>
        </>
      )}
    </p>
  );
}
