// Fase 4: montagem de uma serie de cortes em um unico volume 3D.
//
// Funcoes puras (sem DOM, sem Worker) para poderem ser testadas no Node.
// O worker so entrega os cortes ja parseados; a ordenacao, a validacao e a
// concatenacao acontecem aqui.

import type { DicomMeta, DicomVolume, OrderStrategy } from "./types";

export interface SliceInput {
  fileName: string;
  meta: DicomMeta;
  /** Valores armazenados deste corte (frames empilhadas, se houver). */
  values: Int16Array | Uint16Array;
}

export type { OrderStrategy };

export interface SeriesAssembly {
  volume: DicomVolume;
  fileNames: string[];
  orderedBy: OrderStrategy;
  sliceSpacing: number | null;
  warnings: string[];
}

export class SeriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeriesError";
  }
}

/**
 * Normal do plano de corte a partir do ImageOrientationPatient.
 * IOP traz 6 valores: 3 da direcao da linha (X) e 3 da coluna (Y);
 * a normal e o produto vetorial entre os dois.
 */
export function sliceNormal(orientation: number[] | null): number[] {
  if (!orientation || orientation.length < 6) return [0, 0, 1];
  const r = orientation.slice(0, 3);
  const c = orientation.slice(3, 6);
  const n = [
    r[1] * c[2] - r[2] * c[1],
    r[2] * c[0] - r[0] * c[2],
    r[0] * c[1] - r[1] * c[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!len) return [0, 0, 1];
  return [n[0] / len, n[1] / len, n[2] / len];
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const ALL_INSTANCE_NUMBERS_UNIQUE = (slices: SliceInput[]): boolean => {
  const seen = new Set<number>();
  for (const s of slices) {
    const n = s.meta.instanceNumber;
    if (n === null) return false;
    if (seen.has(n)) return false;
    seen.add(n);
  }
  return seen.size === slices.length;
};

const ALL_HAVE_POSITION = (slices: SliceInput[]): boolean =>
  slices.every((s) => (s.meta.imagePosition?.length ?? 0) >= 3);

/**
 * Ordena os cortes. Preferimos InstanceNumber (explicito e estavel), depois a
 * projecao da posicao do paciente sobre a normal do plano, e so entao o nome
 * do arquivo. A ordem importa: e ela que define o eixo Z do volume.
 */
export function sortSlices(slices: SliceInput[]): {
  sorted: SliceInput[];
  orderedBy: OrderStrategy;
} {
  const copy = [...slices];

  if (ALL_INSTANCE_NUMBERS_UNIQUE(copy)) {
    copy.sort((a, b) => (a.meta.instanceNumber ?? 0) - (b.meta.instanceNumber ?? 0));
    return { sorted: copy, orderedBy: "instanceNumber" };
  }

  if (ALL_HAVE_POSITION(copy)) {
    const normal = sliceNormal(copy[0].meta.imageOrientation);
    copy.sort(
      (a, b) =>
        dot(a.meta.imagePosition as number[], normal) -
        dot(b.meta.imagePosition as number[], normal),
    );
    return { sorted: copy, orderedBy: "imagePosition" };
  }

  copy.sort((a, b) => a.fileName.localeCompare(b.fileName, "pt-BR", { numeric: true }));
  return { sorted: copy, orderedBy: "fileName" };
}

/**
 * Espacamento entre cortes em mm.
 *
 * A fonte mais confiavel e a distancia entre as posicoes declaration: e o que
 * os arquivos realmente prometeram, e funciona mesmo sem SliceThickness. Sem
 * posicoes (arquivo multi-frame) cai para SpacingBetweenSlices, depois
 * SliceThickness, e por fim no proprio pixel spacing.
 *
 * Nao usamos pixelSpacing para Z: e o espacamento in-plane e da a razao
 * errada no aspecto dos planos MPR.
 */
export function resolveSliceSpacing(sorted: SliceInput[]): number | null {
  if (sorted.length >= 2 && ALL_HAVE_POSITION(sorted)) {
    const normal = sliceNormal(sorted[0].meta.imageOrientation);
    const positions = sorted.map((s) => dot(s.meta.imagePosition as number[], normal));
    const gaps: number[] = [];
    for (let i = 1; i < positions.length; i++) {
      const gap = Math.abs(positions[i] - positions[i - 1]);
      // Ignora lacacos absurdos: em serie montada os cortes sao contiguos.
      if (gap > 1e-6) gaps.push(gap);
    }
    if (gaps.length > 0) {
      const total = gaps.reduce((s, g) => s + g, 0);
      const mean = total / gaps.length;
      const spread = Math.max(...gaps) - Math.min(...gaps);
      // Se a media estiver muito acima do menor gap, ha cortes faltando.
      if (mean <= Math.min(...gaps) * 1.5 + 1e-9 || spread < mean * 0.5) {
        return Number(mean.toFixed(6));
      }
    }
  }

  const first = sorted[0]?.meta;
  if (!first) return null;
  if (first.spacingBetweenSlices && first.spacingBetweenSlices > 0) {
    return first.spacingBetweenSlices;
  }
  if (first.sliceThickness && first.sliceThickness > 0) return first.sliceThickness;
  const inPlane = first.pixelSpacing?.[1];
  return inPlane && inPlane > 0 ? inPlane : null;
}

/** Campos que precisam bater entre todos os cortes da serie. */
function assertCompatible(slices: SliceInput[]): void {
  const ref = slices[0];
  const refMeta = ref.meta;
  for (const s of slices.slice(1)) {
    const m = s.meta;
    if (m.rows !== refMeta.rows || m.columns !== refMeta.columns) {
      throw new SeriesError(
        `Matriz divergente: ${ref.fileName} e ${refMeta.columns}x${refMeta.rows}, ` +
          `${s.fileName} e ${m.columns}x${m.rows}.`,
      );
    }
    if (m.pixelRepresentation !== refMeta.pixelRepresentation) {
      throw new SeriesError(
        `Representacao de pixel divergente (signed vs unsigned) entre ${ref.fileName} e ${s.fileName}.`,
      );
    }
    if (m.rescaleSlope !== refMeta.rescaleSlope || m.rescaleIntercept !== refMeta.rescaleIntercept) {
      throw new SeriesError(
        `Escala HU divergente entre ${ref.fileName} e ${s.fileName}.`,
      );
    }
    const a = refMeta.pixelSpacing;
    const b = m.pixelSpacing;
    if (!!a !== !!b || (a && b && (a[0] !== b[0] || a[1] !== b[1]))) {
      throw new SeriesError(`Pixel spacing divergente entre ${ref.fileName} e ${s.fileName}.`);
    }
  }
}

/**
 * Ordena, valida e concatena os cortes em um volume unico.
 * Lanca SeriesError com mensagem legivel quando a serie nao faz sentido.
 */
export function assembleSeries(slices: SliceInput[]): SeriesAssembly {
  if (slices.length === 0) throw new SeriesError("Nenhum corte recebido.");

  assertCompatible(slices);

  const { sorted, orderedBy } = sortSlices(slices);
  const refMeta = sorted[0].meta;
  const { rows, columns } = refMeta;

  const framesPerSlice = sorted.map((s) => Math.max(1, s.meta.numberOfFrames));
  const totalSlices = framesPerSlice.reduce((n, f) => n + f, 0);
  const plane = rows * columns;

  const warnings: string[] = [];

  // Os cortes de um so arquivo multi-frame ja vem ordenados; com varios
  // arquivos, o InstanceNumber manda e um multi-frame no meio quebraria a
  // ordem, entao sinalizamos.
  if (sorted.length > 1 && framesPerSlice.some((f) => f > 1)) {
    warnings.push(
      "Algum arquivo tem mais de um frame; a ordem entre arquivos e entre frames pode nao refletir Z.",
    );
  }

  const signed = refMeta.pixelRepresentation === "signed";
  const values: Int16Array | Uint16Array = signed
    ? new Int16Array(plane * totalSlices)
    : new Uint16Array(plane * totalSlices);

  let offset = 0;
  for (const s of sorted) {
    const expected = plane * Math.max(1, s.meta.numberOfFrames);
    if (s.values.length < expected) {
      throw new SeriesError(
        `${s.fileName} tem ${s.values.length} valores, esperado ${expected}. Pixel data truncado.`,
      );
    }
    const dst = signed
      ? (values as Int16Array).subarray(offset, offset + expected)
      : (values as Uint16Array).subarray(offset, offset + expected);
    dst.set(s.values.subarray(0, expected) as never);
    offset += expected;
  }

  const sliceSpacing = resolveSliceSpacing(sorted);

  return {
    volume: {
      values,
      rows,
      columns,
      slices: totalSlices,
      rescaleSlope: refMeta.rescaleSlope,
      rescaleIntercept: refMeta.rescaleIntercept,
      sliceSpacing,
      pixelSpacing: refMeta.pixelSpacing,
      sourceFileNames: sorted.map((s) => s.fileName),
    },
    fileNames: sorted.map((s) => s.fileName),
    orderedBy,
    sliceSpacing,
    warnings,
  };
}

/** Espacamento em Z de um volume multi-frame de arquivo unico. */
export function singleFileSliceSpacing(meta: DicomMeta, sliceCount: number): number | null {
  if (meta.spacingBetweenSlices && meta.spacingBetweenSlices > 0) return meta.spacingBetweenSlices;
  if (meta.sliceThickness && meta.sliceThickness > 0) return meta.sliceThickness;
  if (sliceCount > 1 && meta.imagePosition && meta.imagePosition.length >= 3) {
    return null; // sem posicoes por frame, nao da para derivar
  }
  const inPlane = meta.pixelSpacing?.[1];
  return inPlane && inPlane > 0 ? inPlane : null;
}
