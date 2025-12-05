import { useEffect, useState, type CSSProperties } from "react";
import {
  analyzeLogoAppearance,
  COMPACT_LOGO_DEFAULT,
  HERO_LOGO_DEFAULT,
} from "../lib/logoAppearance";

export type LogoAppearanceVariant = "hero" | "compact";

const VARIANT_DEFAULTS: Record<LogoAppearanceVariant, CSSProperties> = {
  hero: HERO_LOGO_DEFAULT,
  compact: COMPACT_LOGO_DEFAULT,
};

/**
 * Reactive wrapper around `analyzeLogoAppearance` that falls back to variant defaults.
 * Returns inline CSS props so components can spread them directly on `<img>` tags.
 */
export function useLogoAppearance(
  src: string,
  variant: LogoAppearanceVariant = "hero",
): CSSProperties {
  const base = VARIANT_DEFAULTS[variant];
  const [style, setStyle] = useState<CSSProperties>(() => ({ ...base }));

  useEffect(() => {
    let cancelled = false;
    analyzeLogoAppearance(src)
      .then((result) => {
        if (cancelled) return;
        setStyle(adaptLogoStyle(result, variant));
      })
      .catch(() => {
        if (!cancelled) setStyle({ ...base });
      });
    return () => {
      cancelled = true;
    };
  }, [src, variant, base]);

  return style;
}

/** Blend the analyzed style with opinionated defaults for each variant. */
function adaptLogoStyle(style: CSSProperties, variant: LogoAppearanceVariant): CSSProperties {
  if (variant === "hero") {
    return { ...HERO_LOGO_DEFAULT, ...style };
  }

  const padding =
    typeof style.padding === "number"
      ? Math.max(4, Math.min(10, style.padding * 0.4))
      : COMPACT_LOGO_DEFAULT.padding;

  return {
    background: style.background ?? COMPACT_LOGO_DEFAULT.background,
    border: style.border ?? COMPACT_LOGO_DEFAULT.border,
    boxShadow: style.boxShadow ?? COMPACT_LOGO_DEFAULT.boxShadow,
    padding,
    borderRadius: COMPACT_LOGO_DEFAULT.borderRadius,
  };
}
