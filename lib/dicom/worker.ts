// Fase 3: leitura de UM arquivo .dcm por vez em Web Worker.
// Extrai os metadados e devolve o pixel data como typed array transferivel,
// para a thread principal nao precisar do ArrayBuffer original.

import dicomParser from "dicom-parser";
import type { DicomMeta, DicomParseResult, DicomVolume, WorkerRequest, WorkerResponse } from "./types";

/** Tags que o OdontoVision precisa para reconstruir o volume. */
const TAGS = {
  transferSyntax: "x00020010",
  sopClass: "x00080016",
  patientName: "x00100010",
  patientId: "x00100020",
  studyDate: "x00080020",
  seriesDescription: "x0008103e",
  manufacturer: "x00081090",
  modality: "x00080060",
  rows: "x00280010",
  columns: "x00280011",
  samplesPerPixel: "x00280002",
  numberOfFrames: "x00280008",
  pixelSpacing: "x00280030",
  sliceThickness: "x00180050",
  spacingBetweenSlices: "x00180088",
  imagePosition: "x00200032",
  imageOrientation: "x00200037",
  rescaleSlope: "x00281052",
  rescaleIntercept: "x00281053",
  rescaleType: "x00281054",
  bitsAllocated: "x00280100",
  bitsStored: "x00280101",
  pixelRepresentation: "x00280103",
  windowCenter: "x00281050",
  windowWidth: "x00281051",
} as const;

/** Transfer syntaxes que exigem um decoder antes de virar volume. */
const COMPRESSED_SYNTAXES = new Set([
  "1.2.840.10008.1.2.4.50", // JPEG Baseline
  "1.2.840.10008.1.2.4.51", // JPEG Extended
  "1.2.840.10008.1.2.4.57", // JPEG Lossless
  "1.2.840.10008.1.2.4.70", // JPEG Lossless SV1
  "1.2.840.10008.1.2.4.80", // JPEG-LS Lossless
  "1.2.840.10008.1.2.4.81", // JPEG-LS Lossy
  "1.2.840.10008.1.2.4.90", // JPEG 2000 Lossless
  "1.2.840.10008.1.2.4.91", // JPEG 2000
  "1.2.840.10008.1.2.5", // RLE Lossless
]);

/** "0.25\0.25" -> [0.25, 0.25] */
function splitNumeric(value: string | undefined | null): number[] | null {
  if (!value) return null;
  const parts = value
    .split("\\")
    .map((p) => Number.parseFloat(p))
    .filter((n) => Number.isFinite(n));
  return parts.length > 0 ? parts : null;
}

/**
 * Copia o pixel data nativo para um Int16/Uint16Array.
 * So nao comprimido: para dados encapsulados, dicom-parser expoe
 * dataSet.pixelData.frames e o conteudo ainda precisa ser descomprimido.
 */
function extractNativeValues(
  byteArray: Uint8Array,
  dataOffset: number,
  dataLength: number,
  count: number,
  signed: boolean,
): Int16Array | Uint16Array {
  const source = new DataView(
    byteArray.buffer,
    byteArray.byteOffset + dataOffset,
    dataLength,
  );
  const values = signed ? new Int16Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const v = source.getInt16(i * 2, true); // little endian
    if (signed) (values as Int16Array)[i] = v;
    else (values as Uint16Array)[i] = v & 0xffff;
  }
  return values;
}

function parseDicom(byteArray: Uint8Array, fileName: string): DicomParseResult {
  const dataSet = dicomParser.parseDicom(byteArray);

  const rows = dataSet.uint16(TAGS.rows) ?? 0;
  const columns = dataSet.uint16(TAGS.columns) ?? 0;
  const bitsAllocated = dataSet.uint16(TAGS.bitsAllocated) ?? 0;
  const signed = dataSet.uint16(TAGS.pixelRepresentation) === 1;
  const slope = Number.parseFloat(dataSet.string(TAGS.rescaleSlope) ?? "1") || 1;
  const intercept = Number.parseFloat(dataSet.string(TAGS.rescaleIntercept) ?? "0") || 0;
  const transferSyntax = dataSet.string(TAGS.transferSyntax) ?? null;
  const needsDecompression = transferSyntax ? COMPRESSED_SYNTAXES.has(transferSyntax) : false;
  const frames = Number.parseInt(dataSet.string(TAGS.numberOfFrames) ?? "1", 10) || 1;
  const pixelSpacing = splitNumeric(dataSet.string(TAGS.pixelSpacing));

  const meta: DicomMeta = {
    transferSyntax,
    sopClass: dataSet.string(TAGS.sopClass) ?? null,
    patientName: dataSet.string(TAGS.patientName) ?? null,
    patientId: dataSet.string(TAGS.patientId) ?? null,
    studyDate: dataSet.string(TAGS.studyDate) ?? null,
    seriesDescription: dataSet.string(TAGS.seriesDescription) ?? null,
    manufacturer: dataSet.string(TAGS.manufacturer) ?? null,
    modality: dataSet.string(TAGS.modality) ?? null,
    rows,
    columns,
    samplesPerPixel: dataSet.uint16(TAGS.samplesPerPixel) ?? 1,
    numberOfFrames: frames,
    pixelSpacing,
    sliceThickness: Number.parseFloat(dataSet.string(TAGS.sliceThickness) ?? "") || null,
    spacingBetweenSlices:
      Number.parseFloat(dataSet.string(TAGS.spacingBetweenSlices) ?? "") || null,
    imagePosition: splitNumeric(dataSet.string(TAGS.imagePosition)),
    imageOrientation: splitNumeric(dataSet.string(TAGS.imageOrientation)),
    rescaleSlope: slope,
    rescaleIntercept: intercept,
    rescaleType: dataSet.string(TAGS.rescaleType) ?? null,
    bitsAllocated,
    bitsStored: dataSet.uint16(TAGS.bitsStored) ?? 0,
    pixelRepresentation: signed ? "signed" : "unsigned",
    windowCenter: Number.parseFloat(dataSet.string(TAGS.windowCenter) ?? "") || null,
    windowWidth: Number.parseFloat(dataSet.string(TAGS.windowWidth) ?? "") || null,
  };

  let volume: DicomVolume | null = null;
  const element = dataSet.elements.x7fe00010;
  const expected = rows * columns * frames;

  // SamplesPerPixel > 1 significa imagem colorida: fora do escopo do
  // viewer de tomografia, entao nao montamos volume.
  const isGrayscale = (meta.samplesPerPixel ?? 1) === 1;
  const bitsOk = bitsAllocated === 16;

  if (element && isGrayscale && bitsOk && !needsDecompression && expected > 0) {
    const count = Math.min(expected, Math.floor(element.length / 2));
    volume = {
      values: extractNativeValues(byteArray, element.dataOffset, count * 2, count, signed),
      rows,
      columns,
      slices: frames,
      rescaleSlope: slope,
      rescaleIntercept: intercept,
      sliceSpacing: pixelSpacing?.[1] ?? meta.spacingBetweenSlices ?? null,
    };
  }

  return {
    ok: true,
    fileName,
    meta,
    volume,
    needsDecompression,
    tagCount: Object.keys(dataSet.elements).length,
    warnings: dataSet.warnings,
  };
}

// Dentro de um worker, `self` e o DedicatedWorkerGlobalScope. Sem o
// webworker lib o TS resolve `self` como Window, entamo estreitamos o tipo.
const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, byteArray, fileName } = event.data;
  try {
    const payload = parseDicom(new Uint8Array(byteArray), fileName);
    // Transferimos o buffer do pixel data para nao copiar.
    const transfer: Transferable[] = payload.volume
      ? [payload.volume.values.buffer as Transferable]
      : [];
    const response: WorkerResponse = { id, type: "result", payload };
    post(response, transfer);
  } catch (error) {
    // dicom-parser lanca um objeto puro { exception, dataSet }, nao uma Error,
    // entao o catch precisa cobrir os dois formatos.
    const e = error as { exception?: string; message?: string } | undefined;
    const message = e?.exception ?? e?.message ?? String(error);
    const response: WorkerResponse = {
      id,
      type: "error",
      payload: { fileName, message },
    };
    post(response);
  }
};
