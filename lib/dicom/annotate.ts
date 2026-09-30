import type { DicomVolume, Plane } from "./types";
import { planeDimensions } from "./volume.ts";

/**
 * Uma anotacao: um texto livre amarrado a um ponto de um plano e de um corte.
 *
 * Nao entra em `Measurement` de proposito: aquela union existe para valores
 * que o app calcula (mm, graus, HU) e que o relatorio soma. Uma anotacao nao
 * tem valor numerico nenhum, e enfiar um `kind: "text"` la forçaria todo
 * consumidor -- canvas, sidebar, relatorio -- a tratar um caso que nao tem
 * medida nenhuma. Regua e anotacao sao coisas diferentes e ficam separadas.
 */
export interface Annotation {
  id: number;
  plane: Plane;
  /** Corte onde a anotacao foi clicada. */
  slice: number;
  /** Ponto de ancoragem, em coordenadas de voxel do plano. */
  u: number;
  v: number;
  text: string;
}

export type AnnotationError = "fora-do-plano" | "texto-vazio";

/**
 * Limite do rotulo. Nao e arbitrario: o texto e desenhado no canvas em cima da
 * imagem, e uma frase de 400 caracteres atravessa a viewport inteira e sai
 * pela metade. Cortar aqui e melhor do que deixar o desenho decidir.
 */
export const MAX_ANNOTATION_CHARS = 60;

/**
 * Limpa o que o usuario digitou antes de virar rotulo.
 *
 * - quebra de linha vira espaco: no canvas o texto sai numa linha so, e um
 *   `\n` solto faria o resto sumir fora da imagem;
 * - espacos internos colapsam e as pontas saem, para o botao poder comparar
 *   o que digitou com o que o usuario viu na lista;
 * - o corte em 60 caracteres vem com reticencias, para o rotulo cortado ainda
 *   se declarar cortado em vez de parecer completo.
 */
export function sanitizeAnnotationText(raw: string): string {
  const limpo = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (limpo.length <= MAX_ANNOTATION_CHARS) return limpo;
  return `${limpo.slice(0, MAX_ANNOTATION_CHARS - 1).trimEnd()}\u2026`;
}

/**
 * Confere o ponto e o texto e devolve a anotacao pronta.
 *
 * Texto vazio e recusado, e nao aceito como rotudo vazio: uma anotacao sem
 * texto e invisivel no canvas e some da lista visual, e o usuario fica sem
 * nenhuma pista de onde ela foi parar. Melhor o clique nao fazer nada -- e o
 * hint aparece antes, enquanto o campo ainda esta vazio.
 */
export function buildAnnotation(
  volume: DicomVolume,
  plane: Plane,
  slice: number,
  u: number,
  v: number,
  rawText: string,
  id: number,
): { ok: true; annotation: Annotation } | { ok: false; error: AnnotationError } {
  const text = sanitizeAnnotationText(rawText);
  if (text.length === 0) return { ok: false, error: "texto-vazio" };

  const { columns, rows } = planeDimensions(volume, plane);
  if (
    !Number.isInteger(u) || !Number.isInteger(v) ||
    u < 0 || u >= columns || v < 0 || v >= rows
  ) {
    return { ok: false, error: "fora-do-plano" };
  }

  return { ok: true, annotation: { id, plane, slice, u, v, text } };
}
