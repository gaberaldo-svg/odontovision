import type { DicomVolume, Plane } from "./types";
import { planeDimensions, planeDistanceMm } from "./volume.ts";

/**
 * Uma regua: dois pontos de um mesmo plano e o comprimento em mm.
 *
 * A medicao pertence ao plano e ao corte onde foi feita. Ela nao viaja para os
 * outros planos nem para os outros cortes, como num viewer de PACS -- trocar de
 * corte esconde a regua em vez de a projetar em um lugar onde ela nunca foi
 * desenhada.
 */
export interface Measurement {
  id: number;
  plane: Plane;
  /** Corte onde a regua foi desenhada: o indice que o plano fixa. */
  slice: number;
  a: { u: number; v: number };
  b: { u: number; v: number };
  distanceMm: number;
}

/** Por que um clique nao virou medicao. Vira mensagem na UI e caso de teste. */
export type MeasureError = "fora-do-plano" | "ponto-igual";

/**
 * Previa da regua em andamento: origem, onde o ponteiro esta e o comprimento.
 * Derivado do estado do store pelo viewport, nao guardado -- o store so sabe a
 * origem, o resto muda a cada movimento do ponteiro.
 */
export interface MeasureDraft {
  from: { u: number; v: number };
  /** Onde o ponteiro esta agora, ou null se ainda nao passou sobre a imagem. */
  to: { u: number; v: number } | null;
  distanceMm: number | null;
}

/** Duas casas decimais: o voxel do CBCT costuma ser 0,25 mm. */
function round2(mm: number): number {
  return Math.round(mm * 100) / 100;
}

/**
 * Confere os dois pontos contra o plano e devolve a regua pronta.
 *
 * A validacao e geometrica, nao por faixa: `planeDimensions` e a mesma conta
 * que o cursor usa para aceitar um clique, entao um ponto aceito aqui e um
 * ponto que existe na imagem.
 */
export function buildMeasurement(
  volume: DicomVolume,
  plane: Plane,
  slice: number,
  a: { u: number; v: number },
  b: { u: number; v: number },
  id: number,
): { ok: true; measurement: Measurement } | { ok: false; error: MeasureError } {
  const { columns, rows } = planeDimensions(volume, plane);
  const dentro = (p: { u: number; v: number }) =>
    Number.isInteger(p.u) && Number.isInteger(p.v) && p.u >= 0 && p.u < columns && p.v >= 0 && p.v < rows;

  if (!dentro(a) || !dentro(b)) return { ok: false, error: "fora-do-plano" };
  if (a.u === b.u && a.v === b.v) return { ok: false, error: "ponto-igual" };

  return {
    ok: true,
    measurement: {
      id,
      plane,
      slice,
      a: { u: a.u, v: a.v },
      b: { u: b.u, v: b.v },
      distanceMm: round2(planeDistanceMm(volume, plane, a, b)),
    },
  };
}