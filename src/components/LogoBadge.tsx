import type { CSSProperties } from "react";
import { useLogoAppearance } from "../hooks/useLogoAppearance";
import { COMPACT_LOGO_DEFAULT } from "../lib/logoAppearance";

type Props = {
  src: string;
  alt: string;
  size?: number;
  className?: string;
};

export default function LogoBadge({ src, alt, size = 24, className }: Props) {
  const appearance = useLogoAppearance(src, "compact");
  const paddingValue =
    typeof appearance.padding === "number"
      ? appearance.padding
      : typeof COMPACT_LOGO_DEFAULT.padding === "number"
      ? COMPACT_LOGO_DEFAULT.padding
      : 6;
  const padding = Math.max(4, Math.min(12, paddingValue));
  const wrapperSize = size + padding * 2;

  const wrapperStyle: CSSProperties = {
    ...appearance,
    padding,
    borderRadius: COMPACT_LOGO_DEFAULT.borderRadius,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: wrapperSize,
    height: wrapperSize,
  };

  return (
    <div className={className} style={wrapperStyle}>
      <img
        src={src}
        alt={alt}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
        }}
      />
    </div>
  );
}
