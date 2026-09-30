import type { DicomVolume, Plane } from "./types";
import { planeAngleDeg, planeDimensions, planeDistanceMm, planeHuAt } from "./volume.ts";
import { round1 } from "../format.ts";

/** O que a régua mede: comprimento ou ângulo. */
export type MeasurementKind = "distance" | "angle";

interface MeasurementBase {
  id: number;
  kind: MeasurementKind;
  plane: Plane;
  /** Corte onde a regua foi desenhada: o indice que o plano fixa. */
  slice: number;
}

/**
 * Uma regua: dois pontos de um mesmo plano, o comprimento em mm e a densidade
 * em cada ponta.
 *
 * A medida pertence ao plano e ao corte onde foi feita. Ela nao viaja para os
 * outros planos nem para os outros cortes, como num viewer de PACS -- trocar de
 * corte esconde a regua em vez de a projetar em um lugar onde ela nunca foi
 * desenhada.
 */
export interface DistanceMeasurement extends MeasurementBase {
  kind: "distance";
  a: { u: number; v: number };
  b: { u: number; v: number };
  distanceMm: number;
  /** HU na ponta A e na ponta B, com sinal. */
  huA: number;
  huB: number;
  /** `huB - huA`, com sinal: positivo quando a ponta B e mais densa. */
  deltaHu: number;
}

/**
 * Um ângulo: tres pontos, o vertice no meio e os graus entre os dois bracos.
 *
 * Nao tem `deltaHu`: com tres pontos nao existe um par unico, e escolher um
 * par arbitrario mostraria um numero que o usuario nao pediu. As tres
 * densidades vao na lista, e o delta fica para quem quiser calcular.
 */
export interface AngleMeasurement extends MeasurementBase {
  kind: "angle";
  /** Ponta do primeiro braco. */
  a: { u: number; v: number };
  /** Vertice, onde o angulo e medido. */
  b: { u: number; v: number };
  /** Ponta do segundo braco. */
  c: { u: number; v: number };
  angleDeg: number;
  huA: number;
  huB: number;
  huC: number;
}

export type Measurement = DistanceMeasurement | AngleMeasurement;

/** Por que um clique nao virou medicao. Vira mensagem na UI e caso de teste. */
export type MeasureError = "fora-do-plano" | "ponto-igual" | "vertice-igual";

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
  /** HU da origem, para a previa mostrar a densidade da ponta ja clicada. */
  huA: number;
}

/**
 * Previa do angulo em andamento. `points` cresce a cada clique: 0 antes do
 * primeiro, 2 com as duas pontas e o vertice ja marcados, 1 no meio do caminho.
 */
export interface AngleDraft {
  /** Pontos ja clicados, na ordem: pontas e vertice sao os tres. */
  points: { u: number; v: number }[];
  /** Onde o ponteiro esta, para o braço que ainda falta. */
  to: { u: number; v: number } | null;
  /** Degraus do angulo em quanto a ponta existe (2 pontos); null antes disso. */
  angleDeg: number | null;
  /** HU dos pontos ja clicados. */
  hu: number[];
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
 *
 * Os HU sao lidos por `planeHuAt`, o mesmo caminho do readout sob o cursor:
 * se a regua mostrasse outra fonte, ela discordaria do numero que o usuario
 * acabou de ver passando o mouse no ponto.
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

  const huA = Math.round(planeHuAt(volume, plane, slice, a.u, a.v));
  const huB = Math.round(planeHuAt(volume, plane, slice, b.u, b.v));

  return {
    ok: true,
    measurement: {
      id,
      kind: "distance",
      plane,
      slice,
      a: { u: a.u, v: a.v },
      b: { u: b.u, v: b.v },
      distanceMm: round2(planeDistanceMm(volume, plane, a, b)),
      huA,
      huB,
      deltaHu: huB - huA,
    },
  };
}

/**
 * Confere os tres pontos e devolve o angulo pronto.
 *
 * O vertice tem que ser diferente das duas pontas: com um braco de tamanho zero
 * o angulo nao existe, e nao ha valor honesto para mostrar. As tres pontas
 * colineares, ao contrario, sao um angulo legitimo de 0 ou 180 graus -- e e
 * assim que se mede "isto aqui esta reto".
 */
export function buildAngleMeasurement(
  volume: DicomVolume,
  plane: Plane,
  slice: number,
  a: { u: number; v: number },
  b: { u: number; v: number },
  c: { u: number; v: number },
  id: number,
): { ok: true; measurement: AngleMeasurement } | { ok: false; error: MeasureError } {
  const { columns, rows } = planeDimensions(volume, plane);
  const dentro = (p: { u: number; v: number }) =>
    Number.isInteger(p.u) && Number.isInteger(p.v) && p.u >= 0 && p.u < columns && p.v >= 0 && p.v < rows;

  if (!dentro(a) || !dentro(b) || !dentro(c)) return { ok: false, error: "fora-do-plano" };
  const mesmo = (p: { u: number; v: number }, q: { u: number; v: number }) => p.u === q.u && p.v === q.v;
  if (mesmo(a, b) || mesmo(b, c) || mesmo(a, c)) return { ok: false, error: "vertice-igual" };

  const hu = (p: { u: number; v: number }) => Math.round(planeHuAt(volume, plane, slice, p.u, p.v));

  return {
    ok: true,
    measurement: {
      id,
      kind: "angle",
      plane,
      slice,
      a: { u: a.u, v: a.v },
      b: { u: b.u, v: b.v },
      c: { u: c.u, v: c.v },
      angleDeg: round1(planeAngleDeg(volume, plane, a, b, c)),
      huA: hu(a),
      huB: hu(b),
      huC: hu(c),
    },
  };
}