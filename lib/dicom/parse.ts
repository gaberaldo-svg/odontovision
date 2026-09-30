// Parsing de um ou mais arquivos DICOM. Sem DOM e sem Web Worker, para que
// o mesmo codigo rode no browser (via worker.ts) e no Node (nos verificadores).
//
// Envolve o dicom-parser e extrai o pixel data nativo como typed array.

import dicomParser from "dicom-parser";
import type {
  DicomMeta,
  DicomParseResult,
  DicomSeriesResult,
  DicomVolume,
} from "./types";
import { assembleSeries, singleFileSliceSpacing, type SliceInput } from "./series.ts";

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
  instanceNumber: "x00200013",
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
  const source = new DataView(byteArray.buffer, byteArray.byteOffset + dataOffset, dataLength);
  const values = signed ? new Int16Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const v = source.getInt16(i * 2, true); // little endian
    if (signed) (values as Int16Array)[i] = v;
    else (values as Uint16Array)[i] = v & 0xffff;
  }
  return values;
}

function readMeta(dataSet: ReturnType<typeof dicomParser.parseDicom>): DicomMeta {
  const slope = Number.parseFloat(dataSet.string(TAGS.rescaleSlope) ?? "1") || 1;
  const intercept = Number.parseFloat(dataSet.string(TAGS.rescaleIntercept) ?? "0") || 0;
  const transferSyntax = dataSet.string(TAGS.transferSyntax) ?? null;
  const instanceNumberRaw = dataSet.string(TAGS.instanceNumber);

  return {
    transferSyntax,
    sopClass: dataSet.string(TAGS.sopClass) ?? null,
    patientName: dataSet.string(TAGS.patientName) ?? null,
    patientId: dataSet.string(TAGS.patientId) ?? null,
    studyDate: dataSet.string(TAGS.studyDate) ?? null,
    seriesDescription: dataSet.string(TAGS.seriesDescription) ?? null,
    manufacturer: dataSet.string(TAGS.manufacturer) ?? null,
    modality: dataSet.string(TAGS.modality) ?? null,
    rows: dataSet.uint16(TAGS.rows) ?? 0,
    columns: dataSet.uint16(TAGS.columns) ?? 0,
    samplesPerPixel: dataSet.uint16(TAGS.samplesPerPixel) ?? 1,
    numberOfFrames: Number.parseInt(dataSet.string(TAGS.numberOfFrames) ?? "1", 10) || 1,
    instanceNumber: instanceNumberRaw ? Number.parseInt(instanceNumberRaw, 10) || null : null,
    pixelSpacing: splitNumeric(dataSet.string(TAGS.pixelSpacing)),
    sliceThickness: Number.parseFloat(dataSet.string(TAGS.sliceThickness) ?? "") || null,
    spacingBetweenSlices:
      Number.parseFloat(dataSet.string(TAGS.spacingBetweenSlices) ?? "") || null,
    imagePosition: splitNumeric(dataSet.string(TAGS.imagePosition)),
    imageOrientation: splitNumeric(dataSet.string(TAGS.imageOrientation)),
    rescaleSlope: slope,
    rescaleIntercept: intercept,
    rescaleType: dataSet.string(TAGS.rescaleType) ?? null,
    bitsAllocated: dataSet.uint16(TAGS.bitsAllocated) ?? 0,
    bitsStored: dataSet.uint16(TAGS.bitsStored) ?? 0,
    pixelRepresentation: dataSet.uint16(TAGS.pixelRepresentation) === 1 ? "signed" : "unsigned",
    windowCenter: Number.parseFloat(dataSet.string(TAGS.windowCenter) ?? "") || null,
    windowWidth: Number.parseFloat(dataSet.string(TAGS.windowWidth) ?? "") || null,
  };
}

/** Motivo pelo qual o arquivo nao virou volume, ou null se virou. */
function volumeBlocker(meta: DicomMeta, needsDecompression: boolean, hasPixelData: boolean): string | null {
  if (needsDecompression) return "sintaxe comprimida";
  if (meta.samplesPerPixel > 1) return "imagem colorida (SamplesPerPixel > 1)";
  if (meta.bitsAllocated !== 16) return `BitsAllocated ${meta.bitsAllocated} (esperado 16)`;
  if (!hasPixelData) return "sem pixel data";
  if (meta.rows <= 0 || meta.columns <= 0) return "matriz vazia";
  return null;
}

export function parseDicom(byteArray: Uint8Array, fileName: string): DicomParseResult {
  const dataSet = dicomParser.parseDicom(byteArray);
  const meta = readMeta(dataSet);
  const needsDecompression = meta.transferSyntax
    ? COMPRESSED_SYNTAXES.has(meta.transferSyntax)
    : false;

  const element = dataSet.elements.x7fe00010;
  const expected = meta.rows * meta.columns * meta.numberOfFrames;
  const blocker = volumeBlocker(meta, needsDecompression, Boolean(element));

  let volume: DicomVolume | null = null;
  if (!blocker && element && expected > 0) {
    const count = Math.min(expected, Math.floor(element.length / 2));
    const signed = meta.pixelRepresentation === "signed";
    volume = {
      values: extractNativeValues(byteArray, element.dataOffset, count * 2, count, signed),
      rows: meta.rows,
      columns: meta.columns,
      slices: meta.numberOfFrames,
      rescaleSlope: meta.rescaleSlope,
      rescaleIntercept: meta.rescaleIntercept,
      // Z vem de SpacingBetweenSlices/SliceThickness. O codigo antigo usava
      // pixelSpacing[1] aqui, que e o espacamento in-plane e quebra o aspecto
      // dos planos MPR.
      sliceSpacing: singleFileSliceSpacing(meta, meta.numberOfFrames),
      pixelSpacing: meta.pixelSpacing,
      sourceFileNames: [fileName],
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

/** Converte um resultado ja parseado no formato de entrada da montagem. */
function toSliceInput(result: DicomParseResult): SliceInput | null {
  if (!result.volume) return null;
  return { fileName: result.fileName, meta: result.meta, values: result.volume.values };
}

/**
 * Monta uma serie a partir de varios arquivos ja lidos na memoria.
 * `bytes` vem no mesmo formato do FileList do browser.
 */
export function parseSeries(
  files: { byteArray: ArrayBuffer; fileName: string }[],
): DicomSeriesResult {
  if (files.length === 0) {
    return {
      ok: true,
      fileNames: [],
      meta: emptyMeta(),
      volume: emptyVolume(),
      orderedBy: "fileName",
      sliceSpacing: null,
      skipped: [],
      warnings: ["Nenhum arquivo recebido."],
    };
  }

  const skipped: { fileName: string; reason: string }[] = [];
  const inputs: SliceInput[] = [];
  const parsed: DicomParseResult[] = [];

  for (const file of files) {
    let result: DicomParseResult;
    try {
      result = parseDicom(new Uint8Array(file.byteArray), file.fileName);
    } catch (error) {
      const e = error as { exception?: string; message?: string } | undefined;
      skipped.push({ fileName: file.fileName, reason: e?.exception ?? e?.message ?? "falha ao parsear" });
      continue;
    }
    parsed.push(result);
    const input = toSliceInput(result);
    if (input) inputs.push(input);
    else {
      skipped.push({
        fileName: file.fileName,
        reason: volumeBlocker(result.meta, result.needsDecompression, Boolean(result.meta.rows)) ??
          "sem volume",
      });
    }
  }

  if (inputs.length === 0) {
    return {
      ok: true,
      fileNames: [],
      meta: parsed[0]?.meta ?? emptyMeta(),
      volume: emptyVolume(),
      orderedBy: "fileName",
      sliceSpacing: null,
      skipped,
      warnings: parsed.flatMap((p) => p.warnings),
    };
  }

  // assembleSeries lanca SeriesError com mensagem legivel quando a serie
  // nao faz sentido; o worker repassa esse texto para a UI.
  const assembly = assembleSeries(inputs);

  // Os metadados do primeiro corte ja ordenado descrevem a serie inteira.
  const first = parsed.find((p) => p.fileName === assembly.fileNames[0])?.meta ?? parsed[0].meta;

  return {
    ok: true,
    fileNames: assembly.fileNames,
    meta: { ...first, numberOfFrames: assembly.volume.slices },
    volume: assembly.volume,
    orderedBy: assembly.orderedBy,
    sliceSpacing: assembly.sliceSpacing,
    skipped,
    warnings: [...assembly.warnings, ...parsed.flatMap((p) => p.warnings)],
  };
}

function emptyMeta(): DicomMeta {
  return {
    transferSyntax: null,
    sopClass: null,
    patientName: null,
    patientId: null,
    studyDate: null,
    seriesDescription: null,
    manufacturer: null,
    modality: null,
    rows: 0,
    columns: 0,
    samplesPerPixel: 1,
    numberOfFrames: 0,
    instanceNumber: null,
    pixelSpacing: null,
    sliceThickness: null,
    spacingBetweenSlices: null,
    imagePosition: null,
    imageOrientation: null,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    rescaleType: null,
    bitsAllocated: 0,
    bitsStored: 0,
    pixelRepresentation: "unsigned",
    windowCenter: null,
    windowWidth: null,
  };
}

function emptyVolume(): DicomVolume {
  return {
    values: new Uint16Array(0),
    rows: 0,
    columns: 0,
    slices: 0,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    sliceSpacing: null,
    pixelSpacing: null,
  };
}
