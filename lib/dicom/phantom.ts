import type { DicomVolume } from "./types.ts";
import { MOCK_EXAM } from "../mock-data.ts";

/**
 * Phantom de tomografia gerado em memoria.
 *
 * Serve para o botao "exame de exemplo": um visitante que clone o repositorio
 * clica num botao e ve uma tomografia, sem baixar arquivo, sem `npm run sample`
 * e sem rede. Sem isto o demo so mostrava os metadados e um quadro vazio --
 * que e a pior primeira impressao possivel para quem esta olhando o portfolio.
 *
 * A geometria e a MESMA de `scripts/make-sample-series.mjs`, e as duas
 * formulas ficam em fusao de proposito: o E2E compara o demo com a serie
 * voxel a voxel, entao divergir aqui faria o teste falhar e diria exatamente
 * por que.
 *
 * Nao e dado medico. E uma fantasia de dentes e osso, para exercitar o
 * visualizador.
 */

const COLS = 64;
const ROWS = 64;
const SLICES = 32;
const CX = (COLS - 1) / 2;
const CY = (ROWS - 1) / 2;

const HU_DENSE = 2200;
const HU_SHELL = 900;
const HU_SOFT = 120;
const HU_AIR = -900;

const BLOB_X = CX + 16;
const BLOB_Y = CY - 12;
const BLOB_R = 4;
const BLOB_Z0 = 8;
const BLOB_Z1 = 23;

/** Raio do osso denso na fatia z: cresce da base para o topo. */
export function denseRadiusAt(z: number): number {
  return 6 + 6 * (z / (SLICES - 1));
}

/**
 * HU em um voxel. O `+ ((x*7 + y*13 + z*29) % 5 - 2)` final e ruido de
 * detector: sem ele a imagem fica com faixas perfectlye e nao parece uma
 * tomografia real.
 */
export function huAtVoxel(x: number, y: number, z: number): number {
  let hu: number;
  const rBlob = Math.hypot(x - BLOB_X, y - BLOB_Y);
  if (z >= BLOB_Z0 && z <= BLOB_Z1 && rBlob < BLOB_R) {
    hu = HU_DENSE;
  } else {
    const r = Math.hypot(x - CX, y - CY);
    const dense = denseRadiusAt(z);
    if (r < dense) hu = HU_DENSE;
    else if (r < dense + 3) hu = HU_SHELL;
    else if (r < 22) hu = HU_SOFT;
    else hu = HU_AIR;
  }
  return hu + ((x * 7 + y * 13 + z * 29) % 5) - 2;
}

/** Metadados de exibição que batem com o volume, para o botão de exemplo. */
export function phantomMetadata() {
  return {
    ...MOCK_EXAM,
    matrixDimensions: [COLS, ROWS, SLICES] as [number, number, number],
    voxelSize: [0.25, 0.25, 1.0] as [number, number, number],
    sliceThickness: 1.0,
  };
}

/**
 * Contagem de cortes por viewport, coerente com o phantom.
 *
 * Sem isto o demo misturava o volume de 64x64x32 com os cortes do
 * `MOCK_SLICE_COUNT` (180/512/512): o slider deixava o corte 90 de um volume de
 * 32, e todo HU saia `NaN` — inclusive o das pontas da regua. Nenhum teste
 * automatizado pegou, porque so um teste visual com o app aberto mostra.
 */
export function phantomSliceCount(): Record<"Axial" | "Coronal" | "Sagital", number> {
  return { Axial: SLICES, Coronal: ROWS, Sagital: COLS };
}

export function phantomVolume(): DicomVolume {
  const values = new Int16Array(COLS * ROWS * SLICES);
  for (let z = 0; z < SLICES; z++) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        values[(z * ROWS + y) * COLS + x] = huAtVoxel(x, y, z);
      }
    }
  }
  return {
    values,
    rows: ROWS,
    columns: COLS,
    slices: SLICES,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    sliceSpacing: 1.0,
    pixelSpacing: [0.25, 0.25],
    sourceFileNames: ["phantom-demo"],
  };
}
