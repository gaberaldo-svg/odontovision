/**
 * Milimetros com duas casas decimais.
 *
 * Duas casas resolvem o voxel do CBCT (0,25 mm) sem mentir sobre o resto, e o
 * texto cabe na sidebar e no rotulo desenhado no canvas -- os dois precisam
 * bater caractere a caractere com o que o teste le.
 */
export function formatMm(mm: number): string {
  return `${mm.toFixed(2)} mm`;
}

/** Densidade com unidade, para rotulo curto de canvas e de lista. */
export function formatHu(hu: number): string {
  return `${hu} HU`;
}

/**
 * Diferenca entre duas pontas, com sinal explicito quando positiva.
 *
 * O sinal importa: "-1310 HU" e "+1310 HU" sao a mesma distancia entre as
 * pontas, mas so um deles diz que ponta cameca e a mais densa.
 */
export function formatDeltaHu(hu: number): string {
  return hu > 0 ? `+${hu} HU` : `${hu} HU`;
}