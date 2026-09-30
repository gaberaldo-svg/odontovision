// Fase 3: matematica pura de volume e janela/contraste.
// Sem React, sem DOM: da para testar direto no Node (scripts/verify-volume.mjs).

import type { DicomVolume } from "./types";

/** Menor/maior valor armazenado do volume. Usado para normalizar presets. */
export function storedRange(volume: DicomVolume): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < volume.values.length; i++) {
    const v = volume.values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

/** HU de um voxel. coords em px de imagem; z e o indice do corte. */
export function huAt(volume: DicomVolume, x: number, y: number, z = 0): number {
  const { rows, columns, slices, values, rescaleSlope, rescaleIntercept } = volume;
  if (x < 0 || y < 0 || z < 0 || x >= columns || y >= rows || z >= slices) return Number.NaN;
  const stored = values[z * rows * columns + y * columns + x];
  return stored * rescaleSlope + rescaleIntercept;
}

/** Indice linear no array de valores, ou -1 fora dos limites. */
export function voxelIndex(
  volume: DicomVolume,
  x: number,
  y: number,
  z: number,
): number {
  if (x < 0 || y < 0 || z < 0) return -1;
  if (x >= volume.columns || y >= volume.rows || z >= volume.slices) return -1;
  return z * volume.rows * volume.columns + y * volume.columns + x;
}

/**
 * Converte HU para cinza 0-255 pela regra DICOM:
 *   abaixo de wc - ww/2  -> 0
 *   acima  de wc + ww/2  -> 255
 *   no meio, interpolacao linear.
 */
export function huToGray(hu: number, windowWidth: number, windowCenter: number): number {
  // ww <= 0 produz um degrau; usamos o minimo util para nao dividir por zero.
  const ww = Math.max(1, windowWidth);
  const lower = windowCenter - ww / 2;
  if (hu <= lower) return 0;
  if (hu >= lower + ww) return 255;
  return Math.round(((hu - lower) / ww) * 255);
}

/**
 * Fatia axial -> ImageData pronto para ctx.putImageData.
 * `scale` e o tamanho final de cada pixel da imagem (para supersampling
 * do upscale nearest-neighbor usado na visualizacao).
 */
export function sliceToImageData(
  volume: DicomVolume,
  z: number,
  windowWidth: number,
  windowCenter: number,
  scale = 1,
): ImageData {
  const { rows, columns, values, rescaleSlope, rescaleIntercept } = volume;
  const w = Math.max(1, Math.round(columns * scale));
  const h = Math.max(1, Math.round(rows * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const planeOffset = z * rows * columns;

  for (let dy = 0; dy < h; dy++) {
    const sy = Math.min(rows - 1, Math.floor(dy / scale));
    const rowBase = planeOffset + sy * columns;
    for (let dx = 0; dx < w; dx++) {
      const sx = Math.min(columns - 1, Math.floor(dx / scale));
      const stored = values[rowBase + sx];
      const hu = stored * rescaleSlope + rescaleIntercept;
      const gray = huToGray(hu, windowWidth, windowCenter);
      const p = (dy * w + dx) * 4;
      out[p] = gray;
      out[p + 1] = gray;
      out[p + 2] = gray;
      out[p + 3] = 255;
    }
  }

  return new ImageData(out, w, h);
}

/**
 * W/L sugerido quando o exame nao traz janela propria: cobre o volume
 * inteiro com um poco de folga, para o contraste ficar utilizavel.
 */
export function autoWindow(volume: DicomVolume): { windowWidth: number; windowCenter: number } {
  const { min, max } = storedRange(volume);
  const lowHU = min * volume.rescaleSlope + volume.rescaleIntercept;
  const highHU = max * volume.rescaleSlope + volume.rescaleIntercept;
  const windowWidth = Math.max(1, Math.round((highHU - lowHU) * 1.05));
  const windowCenter = Math.round((highHU + lowHU) / 2);
  return { windowWidth, windowCenter };
}
