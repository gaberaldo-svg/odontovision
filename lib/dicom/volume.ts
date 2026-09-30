// Fase 3/4: matematica pura de volume, janela/contraste e planos MPR.
// Sem React, sem DOM: da para testar direto no Node (scripts/verify-volume.mjs).

import type { DicomVolume, Plane } from "./types";

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
 * Usa o ImageData nativo no browser e um objeto equivalente no Node, para que
 * a conversao HU -> cinza possa ser testada fora do DOM. No browser o
 * resultado e o ImageData de verdade, que e o que ctx.putImageData exige.
 */
function createImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  // O construtor nativo exige ArrayBuffer, e nao ArrayBufferLike (que includeria
  // SharedArrayBuffer). Nossos buffers sempre sao ArrayBuffer.
  if (typeof ImageData !== "undefined") {
    return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height);
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
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

  return createImageData(out, w, h);
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

// ---------------------------------------------------------------------------
// MPR: os tres planos ortogonais
//
// Os valores estao achatados em [z][y][x]. Cada plano fixa um indice e
// percorre os outros dois:
//
//   axial   -> fixa z   (u = x, v = y)
//   coronal -> fixa y   (u = x, v = z)
//   sagital -> fixa x   (u = y, v = z)
//
// Coronal e sagital tem dimensao `slices` no eixo vertical, e nao `rows`.
// ---------------------------------------------------------------------------

/** Dimensoes em voxels de um plano, no eixo horizontal e no vertical. */
export function planeDimensions(volume: DicomVolume, plane: Plane): { columns: number; rows: number } {
  if (plane === "axial") return { columns: volume.columns, rows: volume.rows };
  if (plane === "coronal") return { columns: volume.columns, rows: volume.slices };
  return { columns: volume.rows, rows: volume.slices };
}

/**
 * Quantos pixels de largura um corte ocupa no eixo vertical dos planos MPR.
 *
 * Com o axial o eixo vertical e uma linha da imagem, entao vale 1. Em coronal
 * e sagital o eixo vertical e Z, e cada corte vale `sliceSpacing` mm contra
 * `pixelSpacing[1]` mm por linha. Sem isso a serie apareceria achatada ou
 * esticada em Z, que e o erro classico de MPR.
 */
export function zAspect(volume: DicomVolume): number {
  const rowSpacing = volume.pixelSpacing?.[1] ?? null;
  if (rowSpacing === null || rowSpacing <= 0) return 1;
  const zSpacing = volume.sliceSpacing ?? rowSpacing;
  const ratio = zSpacing / rowSpacing;
  return ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
}

/**
 * Aspecto vertical de um plano, ja resolvido para o axial.
 *
 * Este helper existe porque o calculo do desenho e o do cursor precisam dar
 * exatamente o mesmo numero: quando os dois usavam `zAspect` direto no axial,
 * o `scale` saia reduzido por `sliceSpacing / pixelSpacing` e a imagem do
 * axial encolhia para um quarto do tamanho, enquanto o render continuava
 * correto. Fonte unica agora.
 */
export function planeAspect(volume: DicomVolume, plane: Plane): number {
  return plane === "axial" ? 1 : zAspect(volume);
}

/**
 * Converte coordenadas de um plano (u, v) e o indice fixo em coordenadas
 * do volume. `voxelFromPlane` e `planeFromVoxel` sao inversas.
 */
export function voxelFromPlane(
  plane: Plane,
  index: number,
  u: number,
  v: number,
): { x: number; y: number; z: number } {
  if (plane === "axial") return { x: u, y: v, z: index };
  if (plane === "coronal") return { x: u, y: index, z: v };
  return { x: index, y: u, z: v };
}

/** Inverso de voxelFromPlane: qual o indice fixo e as coords no plano. */
export function planeFromVoxel(
  plane: Plane,
  x: number,
  y: number,
  z: number,
): { index: number; u: number; v: number } {
  if (plane === "axial") return { index: z, u: x, v: y };
  if (plane === "coronal") return { index: y, u: x, v: z };
  return { index: x, u: y, v: z };
}

/** Indice do corte correspondente a um voxel, para o slider do plano. */
export function planeSliceCount(volume: DicomVolume, plane: Plane): number {
  if (plane === "axial") return volume.slices;
  if (plane === "coronal") return volume.rows;
  return volume.columns;
}

/** HU de um ponto em coordenadas de plano. */
export function planeHuAt(
  volume: DicomVolume,
  plane: Plane,
  index: number,
  u: number,
  v: number,
): number {
  const { x, y, z } = voxelFromPlane(plane, index, u, v);
  return huAt(volume, x, y, z);
}

/**
 * Fatia de um plano qualquer -> ImageData pronto para ctx.putImageData.
 *
 * `scale` e o tamanho final de cada voxel na horizontal. O eixo vertical e
 * corrigido por `zAspect`, que e 1 no axial.
 */
export function planeSliceToImageData(
  volume: DicomVolume,
  plane: Plane,
  index: number,
  windowWidth: number,
  windowCenter: number,
  scale = 1,
): ImageData {
  const { columns, rows } = planeDimensions(volume, plane);
  const w = Math.max(1, Math.round(columns * scale));
  const aspect = planeAspect(volume, plane);
  const h = Math.max(1, Math.round(rows * scale * aspect));
  const out = new Uint8ClampedArray(w * h * 4);
  const safeIndex = index >= 0 ? index : 0;

  for (let dy = 0; dy < h; dy++) {
    const v = Math.min(rows - 1, Math.floor(dy / (scale * aspect)));
    for (let dx = 0; dx < w; dx++) {
      const u = Math.min(columns - 1, Math.floor(dx / scale));
      const { x, y, z } = voxelFromPlane(plane, safeIndex, u, v);
      const stored = values3d(volume, x, y, z);
      const hu = stored * volume.rescaleSlope + volume.rescaleIntercept;
      const gray = huToGray(hu, windowWidth, windowCenter);
      const p = (dy * w + dx) * 4;
      out[p] = gray;
      out[p + 1] = gray;
      out[p + 2] = gray;
      out[p + 3] = 255;
    }
  }

  return createImageData(out, w, h);
}

function values3d(volume: DicomVolume, x: number, y: number, z: number): number {
  return volume.values[z * volume.rows * volume.columns + y * volume.columns + x];
}

/**
 * Espessura real de um voxel em mm nas tres direcoes. Usado no readout de
 * posicao e na medicao em mm.
 */
export function voxelSizeMm(volume: DicomVolume): { x: number; y: number; z: number } {
  return {
    x: volume.pixelSpacing?.[0] ?? 1,
    y: volume.pixelSpacing?.[1] ?? 1,
    z: volume.sliceSpacing ?? volume.pixelSpacing?.[1] ?? 1,
  };
}

/**
 * Quanto vale um passo em mm no eixo horizontal e no vertical de um plano.
 *
 * Os eixos do plano nao sao sempre x e y: no axial sao, mas o coronal usa x e
 * z e o sagital usa y e z. Aplicar `pixelSpacing` nos dois eixos mede a serie
 * `sliceSpacing / pixelSpacing` vezes mais curta em Z -- o mesmo deslize que
 * `planeAspect` corrige na tela, aqui na conta.
 */
export function planeVoxelSizeMm(
  volume: DicomVolume,
  plane: Plane,
): { u: number; v: number } {
  const { x, y, z } = voxelSizeMm(volume);
  if (plane === "axial") return { u: x, v: y };
  if (plane === "coronal") return { u: x, v: z };
  return { u: y, v: z };
}

/**
 * Distancia em mm entre dois pontos do mesmo plano.
 *
 * Cada eixo e convertido para mm antes do teorema de Pitagoras. Uma medicao
 * so vale no plano onde foi feita: os dois pontos ficam no mesmo corte, entao
 * o indice fixo nao entra na conta.
 */
export function planeDistanceMm(
  volume: DicomVolume,
  plane: Plane,
  from: { u: number; v: number },
  to: { u: number; v: number },
): number {
  const size = planeVoxelSizeMm(volume, plane);
  const du = (to.u - from.u) * size.u;
  const dv = (to.v - from.v) * size.v;
  return Math.hypot(du, dv);
}
