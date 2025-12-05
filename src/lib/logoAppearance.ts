import type { CSSProperties } from "react";

export const HERO_LOGO_DEFAULT: CSSProperties = {
  padding: 12,
  background: "linear-gradient(135deg, rgba(244,247,254,0.95), rgba(226,232,240,0.7))",
  border: "1px solid rgba(15,23,42,0.12)",
  boxShadow: "0 4px 14px rgba(15,23,42,0.16)",
};

export const COMPACT_LOGO_DEFAULT: CSSProperties = {
  padding: 6,
  background: "linear-gradient(135deg, rgba(248,250,252,0.96), rgba(226,232,240,0.72))",
  border: "1px solid rgba(15,23,42,0.12)",
  boxShadow: "0 2px 8px rgba(15,23,42,0.1)",
  borderRadius: 12,
};

/**
 * Sample a logo image to determine whether we should add padding, borders, or shadows.
 * Helps logos with transparent backgrounds remain legible against both light and dark cards.
 */
export async function analyzeLogoAppearance(src: string): Promise<CSSProperties> {
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
    return HERO_LOGO_DEFAULT;
  }
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(image, 0, 0, size, size);

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, size, size);
  } catch {
    return HERO_LOGO_DEFAULT;
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
      background: "linear-gradient(135deg, rgba(248,250,252,0.96), rgba(226,232,240,0.72))",
      border: "1px solid rgba(15,23,42,0.18)",
      boxShadow: "0 4px 16px rgba(15,23,42,0.18)",
    };
  }
  if (avgBrightness > 200) {
    return {
      padding: 12,
      background: "linear-gradient(135deg, rgba(15,23,42,0.9), rgba(30,41,59,0.75))",
      border: "1px solid rgba(15,23,42,0.32)",
      boxShadow: "0 4px 18px rgba(15,23,42,0.3)",
    };
  }
  return {
    padding: 12,
    background: "linear-gradient(135deg, rgba(240,244,255,0.95), rgba(226,232,240,0.75))",
    border: "1px solid rgba(15,23,42,0.14)",
    boxShadow: "0 4px 16px rgba(15,23,42,0.2)",
  };
}
