// Verifica a fixture .dcm contra o dicom-parser real.
// Roda em Node (o parser e isomorphic), entao valida o mesmo codigo que o browser usa.
//
//   node scripts/verify-sample.mjs
//
// Sai com codigo 1 se qualquer verificacao falhar, para uso em CI.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dicomParser from "dicom-parser";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, "..", "samples", "phantom-64.dcm");

let pass = 0;
let fail = 0;

function check(label, actual, expected, tol = 0) {
  const ok =
    typeof expected === "number" && typeof actual === "number"
      ? Math.abs(actual - expected) <= tol
      : actual === expected;
  if (ok) {
    pass++;
    console.log(`  PASS  ${label.padEnd(30)} ${actual}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label.padEnd(30)} ${actual}  (esperado ${expected})`);
  }
}

const byteArray = new Uint8Array(readFileSync(SAMPLE));

let dataSet;
try {
  dataSet = dicomParser.parseDicom(byteArray);
} catch (err) {
  console.log("FALHA FATAL no parse:", err.exception ?? err.message ?? err);
  process.exit(1);
}

console.log(`\nparse: ${Object.keys(dataSet.elements).length} tags, ${dataSet.warnings.length} avisos\n`);

console.log("-- file meta --");
check("TransferSyntaxUID", dataSet.string("x00020010"), "1.2.840.10008.5.1.4.1.1.2");
check("MediaStorageSOPClassUID", dataSet.string("x00020002"), "1.2.840.10008.5.1.4.1.1.2");

console.log("\n-- paciente / serie --");
check("PatientName", dataSet.string("x00100010"), "ANONIMO^CBCT");
check("PatientID", dataSet.string("x00100020"), "CBCT-2024-0142");
check("SeriesDescription", dataSet.string("x0008103e"), "CBCT - Maxilar Superior");
check("Modality", dataSet.string("x00080060"), "CT");

console.log("\n-- geometria --");
check("Rows", dataSet.uint16("x00280010"), 64);
check("Columns", dataSet.uint16("x00280011"), 64);
check("SamplesPerPixel", dataSet.uint16("x00280002"), 1);
check("NumberOfFrames", dataSet.intString("x00280008"), 1);
check("PixelSpacing", dataSet.string("x00280030"), "0.25\\0.25");
check("SliceThickness", dataSet.string("x00180050"), "2.0");
check("ImagePositionPatient", dataSet.string("x00200032"), "-102.5\\-102.5\\-45.0");
check("ImageOrientationPatient", dataSet.string("x00200037"), "1\\0\\0");

console.log("\n-- escala / bits --");
check("RescaleSlope", dataSet.string("x00281052"), "1");
check("RescaleIntercept", dataSet.string("x00281053"), "0");
check("RescaleType", dataSet.string("x00281054"), "HU");
check("BitsAllocated", dataSet.uint16("x00280100"), 16);
check("BitsStored", dataSet.uint16("x00280101"), 16);
check("HighBit", dataSet.uint16("x00280102"), 15);
check("PixelRepresentation signed", dataSet.uint16("x00280103"), 1);

// --- pixel data ---
// dicom-parser so popula dataSet.pixelData para pixel data encapsulada (comprimida).
// Para dados nativos, o offset e o tamanho vem do elemento.
const el = dataSet.elements.x7fe00010;
const cols = dataSet.uint16("x00280011");
const slope = parseFloat(dataSet.string("x00281052"));
const intercept = parseFloat(dataSet.string("x00281053"));

const huAt = (() => {
  if (!el) return () => NaN;
  const view = new DataView(byteArray.buffer, byteArray.byteOffset + el.dataOffset, el.length);
  return (x, y) => view.getInt16(y * cols * 2 + x * 2, true) * slope + intercept;
})();

console.log("\n-- pixel data (HU) --");
check("element presente", !!el, true);
check("bytes = 64*64*2", el?.length, 8192);
check("HU centro (nucleo)", huAt(32, 32), 2200, 8);
check("HU casca", huAt(32, 40), 900, 8);
check("HU tecido mole", huAt(32, 50), 120, 8);
check("HU ar", huAt(2, 2), -900, 8);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
