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
  pixelSpacing: number[] | null;
  sliceThickness: number | null;
  spacingBetweenSlices: number | null;
  imagePosition: number[] | null;
  imageOrientation: number[] | null;
  rescaleSlope: number;
  rescaleIntercept: number;
  rescaleType: string | null;
  bitsAllocated: number;
  bitsStored: number;
  pixelRepresentation: "signed" | "unsigned";
  windowCenter: number | null;
  windowWidth: number | null;
}

/**
 * Pixel data em valores armazenados (nao em HU).
 * Guardamos o valor bruto e aplicamos
 *   HU = stored * rescaleSlope + rescaleIntercept
 * na leitura, que preserva a precisao original.
 */
export interface DicomVolume {
  /** rows * columns * numberOfFrames valores armazenados. */
  values: Int16Array | Uint16Array;
  rows: number;
  columns: number;
  slices: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  /** Espessura entre cortes, em mm. */
  sliceSpacing: number | null;
}

export interface DicomParseResult {
  ok: true;
  fileName: string;
  meta: DicomMeta;
  volume: DicomVolume | null;
  /** Sintaxe comprimida: o volume vem null e exige um decoder. */
  needsDecompression: boolean;
  tagCount: number;
  warnings: string[];
}

export type WorkerRequest = {
  id: number;
  byteArray: ArrayBuffer;
  fileName: string;
};

export type WorkerResponse =
  | { id: number; type: "result"; payload: DicomParseResult }
  | { id: number; type: "error"; payload: { fileName: string; message: string } };
