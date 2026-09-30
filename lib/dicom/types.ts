// Tipos compartilhados entre o worker de parsing e o cliente.
// Ficam num arquivo proprio para nao duplicar as interfaces.

export interface DicomMeta {
  transferSyntax: string | null;
  sopClass: string | null;
  patientName: string | null;
  patientId: string | null;
  studyDate: string | null;
  seriesDescription: string | null;
  manufacturer: string | null;
  modality: string | null;
  rows: number;
  columns: number;
  samplesPerPixel: number;
  numberOfFrames: number;
  /** Ordena os cortes quando nao ha InstanceNumber. */
  instanceNumber: number | null;
  pixelSpacing: number[] | null;
  sliceThickness: number | null;
  spacingBetweenSlices: number | null;
  imagePosition: number[] | null;
  imageOrientation: number[] | null;
  rescaleSlope: number;
  rescaleIntercept: number;
  rescaleType: string | null;
  /**
   * PixelPaddingValue (0028,0120). JPEG entrega 8 bits sem sinal dentro de um
   * container de 16; o padding e o que faz `pixel + padding` caber no
   * BitsAllocated declarado. Vale 0 quando ausente, que e o caso comum.
   */
  pixelPaddingValue: number;
  bitsAllocated: number;
  bitsStored: number;
  pixelRepresentation: "signed" | "unsigned";
  windowCenter: number | null;
  windowWidth: number | null;
}

/** Os tres planos ortogonais que o viewer reconstrói. */
export type Plane = "axial" | "coronal" | "sagittal";

/**
 * Como os cortes de uma serie foram ordenados antes de virar volume.
 * Vive aqui (e nao em series.ts) para que types.ts nao dependa do modulo que
 * importa types.ts.
 */
export type OrderStrategy = "instanceNumber" | "imagePosition" | "fileName";

/**
 * Pixel data em valores armazenados (nao em HU).
 * Guardamos o valor bruto e aplicamos
 *   HU = stored * rescaleSlope + rescaleIntercept
 * na leitura, que preserva a precisao original.
 *
 *(values) esta achatado em ordem [z][y][x], com z variando mais devagar.
 */
export interface DicomVolume {
  /** rows * columns * slices valores armazenados. */
  values: Int16Array | Uint16Array;
  rows: number;
  columns: number;
  slices: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  /** Espessura entre cortes, em mm. Derivada das posicoes quando possivel. */
  sliceSpacing: number | null;
  /** Espacamento em X e Y, em mm. Necessario para o aspecto dos planos MPR. */
  pixelSpacing: number[] | null;
  /** Nomes dos arquivos de origem, na ordem do volume. */
  sourceFileNames?: string[];
}

export interface DicomParseResult {
  ok: true;
  fileName: string;
  meta: DicomMeta;
  volume: DicomVolume | null;
  /** Sintaxe comprimida: o volume vem null e exige um decoder. */
  needsDecompression: boolean;
  /**
   * Onde esta o pixel data, em bytes do arquivo. Vai no resultado porque o
   * decoder de JPEG roda na MAIN THREAD (o `createImageBitmap` e assincrono e
   * o parse e sincrono) e precisa reencontrar o fragmento sem refazer a
   * varredura de elementos.
   */
  pixelData: { dataOffset: number; length: number } | null;
  tagCount: number;
  warnings: string[];
}

/** Resultado de montar varios cortes em um unico volume 3D. */
export interface DicomSeriesResult {
  ok: true;
  fileNames: string[];
  /** Metadados do primeiro corte ja ordenado (representam a serie). */
  meta: DicomMeta;
  volume: DicomVolume;
  /** Como os cortes foram ordenados: instanceNumber, imagePosition ou fileName. */
  orderedBy: OrderStrategy;
  sliceSpacing: number | null;
  /** Cortes ignorados por incompatibilidade, com o motivo. */
  skipped: { fileName: string; reason: string }[];
  warnings: string[];
}

export type DicomInputFile = { byteArray: ArrayBuffer; fileName: string };

export type WorkerRequest =
  | { id: number; kind: "single"; files: [DicomInputFile] }
  | { id: number; kind: "series"; files: DicomInputFile[] };

export type WorkerResponse =
  | { id: number; type: "result"; payload: DicomParseResult }
  | { id: number; type: "series"; payload: DicomSeriesResult }
  | { id: number; type: "error"; payload: { fileName: string; message: string } };
