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