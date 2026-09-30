// Fase 2: leitura de UM arquivo .dcm e extracao de metadados.
// Roda em Web Worker para nao travar a UI em volumes grandes.

import dicomParser from "dicom-parser";

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
};

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

function parseInWorker(byteArray: Uint8Array, fileName: string) {
  const dataSet = dicomParser.parseDicom(byteArray);

  const rows = dataSet.uint16(TAGS.rows) ?? 0;
  const columns = dataSet.uint16(TAGS.columns) ?? 0;
  const bitsAllocated = dataSet.uint16(TAGS.bitsAllocated) ?? 0;
  const signed = dataSet.uint16(TAGS.pixelRepresentation) === 1;
  const slope = Number.parseFloat(dataSet.string(TAGS.rescaleSlope) ?? "1") || 1;
  const intercept = Number.parseFloat(dataSet.string(TAGS.rescaleIntercept) ?? "0") || 0;

  const transferSyntax = dataSet.string(TAGS.transferSyntax) ?? null;
  const pixelElement = dataSet.elements.x7fe00010;
  const frames = Number.parseInt(dataSet.string(TAGS.numberOfFrames) ?? "1", 10) || 1;

  return {
    ok: true,
    fileName,
    meta: {
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
      samplesPerPixel: dataSet.uint16(TAGS.samplesPerPixel),
      numberOfFrames: frames,
      pixelSpacing: splitNumeric(dataSet.string(TAGS.pixelSpacing)),
      sliceThickness: Number.parseFloat(dataSet.string(TAGS.sliceThickness) ?? "") || null,
      spacingBetweenSlices:
        Number.parseFloat(dataSet.string(TAGS.spacingBetweenSlices) ?? "") || null,
      imagePosition: splitNumeric(dataSet.string(TAGS.imagePosition)),
      imageOrientation: splitNumeric(dataSet.string(TAGS.imageOrientation)),
      rescaleSlope: slope,
      rescaleIntercept: intercept,
      rescaleType: dataSet.string(TAGS.rescaleType) ?? null,
      bitsAllocated,
      bitsStored: dataSet.uint16(TAGS.bitsStored),
      pixelRepresentation: signed ? "signed" : "unsigned",
      windowCenter: Number.parseFloat(dataSet.string(TAGS.windowCenter) ?? "") || null,
      windowWidth: Number.parseFloat(dataSet.string(TAGS.windowWidth) ?? "") || null,
    },
    pixelData: {
      // Offset/tamanho do pixel data dentro do ArrayBuffer original.
      // undefined para pixel data encapsulada: nesse caso os frames sao
      // extraidos separadamente pela fase 3.
      offset: pixelElement?.dataOffset ?? null,
      length: pixelElement?.length ?? null,
      isEncapsulated: transferSyntax ? COMPRESSED_SYNTAXES.has(transferSyntax) : false,
      frameBytes: rows * columns * (bitsAllocated / 8),
    },
    tagCount: Object.keys(dataSet.elements).length,
    warnings: dataSet.warnings,
  };
}

self.onmessage = (event) => {
  const { id, byteArray, fileName } = event.data;
  try {
    const result = parseInWorker(new Uint8Array(byteArray), fileName);
    self.postMessage({ id, type: "result", payload: result });
  } catch (error) {
    // dicom-parser lanca um objeto puro { exception, dataSet }, nao uma Error,
    // entao o catch precisa cobrir os dois formatos.
    const e = error as { exception?: string; message?: string } | undefined;
    const message = e?.exception ?? e?.message ?? String(error);
    self.postMessage({ id, type: "error", payload: { fileName, message } });
  }
};
