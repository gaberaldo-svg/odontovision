// Gera um .dcm DICOM Part 10 sintetico e valido, para testes de parsing.
// Explicit VR Little Endian, 1 imagem 64x64 com phantom concentrico.
//
//   node scripts/make-sample-dcm.mjs
//
// A saida vai para samples/ e e git-ignored de proposito: o agente nunca deve
// ler o conteudo binario, so a contagem de arquivos.
//
// Este phantom e concentrico e por isso identico em qualquer direcao: serve
// para testar o plano AXIAL. Para MPR use make-sample-series.mjs.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { el, us, ds, buildFile } from "./lib/dicom-writer.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "samples", "phantom-64.dcm");
const ROWS = 64;
const COLS = 64;

// ---- Pixel data: phantom concentrico com valores em HU ----
const pixels = new Int16Array(ROWS * COLS);
const cx = (COLS - 1) / 2;
const cy = (ROWS - 1) / 2;

for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    const r = Math.hypot(x - cx, y - cy);
    let hu;
    if (r < 8) hu = 2200; // nucleo denso
    else if (r < 12) hu = 900; // casca
    else if (r < 24) hu = 120; // tecido mole
    else hu = -900; // ar
    // textura para nao ficar chapado
    hu += ((x * 7 + y * 13) % 11) - 5;
    pixels[y * COLS + x] = hu;
  }
}

const pixelBytes = new Uint8Array(pixels.buffer);

const SOP_CLASS_UID = "1.2.840.10008.5.1.4.1.1.2"; // CT Image Storage
const SOP_INSTANCE_UID = "1.2.826.0.1.3680043.10.1000.1.1.1";
const IMPL_CLASS_UID = "1.2.826.0.1.3680043.10.1000.1";
const IMPL_VERSION = "ODONTOVISION_1.0";

const file = buildFile(
  {
    sopClassUid: SOP_CLASS_UID,
    sopInstanceUid: SOP_INSTANCE_UID,
    transferSyntaxUid: "1.2.840.10008.1.2.1", // Explicit VR Little Endian
    implClassUid: IMPL_CLASS_UID,
    implVersion: IMPL_VERSION,
  },
  [
    // --- Patient (anonimizado) ---
    el(0x0008, 0x0005, "CS", "ISO_IR 100"),
    el(0x0008, 0x0008, "CS", "ORIGINAL\\PRIMARY\\AXIAL"),
    el(0x0008, 0x0016, "UI", SOP_CLASS_UID),
    el(0x0008, 0x0018, "UI", SOP_INSTANCE_UID),
    el(0x0008, 0x0020, "DA", "20240315"),
    el(0x0008, 0x0030, "TM", "101500"),
    el(0x0008, 0x0060, "CS", "CT"),
    el(0x0008, 0x0070, "LO", "ODONTOPEDIA"),
    el(0x0010, 0x0010, "PN", "ANONIMO^CBCT"),
    el(0x0010, 0x0020, "LO", "CBCT-2024-0142"),
    el(0x0010, 0x0040, "CS", "O"),

    // --- Study / Series ---
    el(0x0020, 0x000d, "UI", "1.2.826.0.1.3680043.10.1000.1.1"),
    el(0x0020, 0x000e, "UI", "1.2.826.0.1.3680043.10.1000.1.1.1"),
    el(0x0020, 0x0010, "SH", "1"),
    el(0x0020, 0x0011, "IS", "1"),
    el(0x0020, 0x0013, "IS", "1"),
    el(0x0008, 0x103e, "LO", "CBCT - Maxilar Superior"),
    el(0x0008, 0x1030, "LO", "AXIAL"),
    el(0x0008, 0x1090, "LO", "Philips Brilliance"),

    // --- Acquisition / Pixel geometry ---
    el(0x0018, 0x0050, "DS", "2.0"), // slice thickness
    el(0x0018, 0x0088, "DS", "0.25"), // spacing between slices
    el(0x0020, 0x1040, "LO", "HFS"),
    el(0x0028, 0x0002, "US", us(1)), // SamplesPerPixel
    el(0x0028, 0x0004, "CS", "MONOCHROME2"),
    el(0x0028, 0x0008, "IS", "1"), // NumberOfFrames
    el(0x0028, 0x0010, "US", us(ROWS)),
    el(0x0028, 0x0011, "US", us(COLS)),
    el(0x0028, 0x0030, "DS", ds("0.25", "0.25")),
    el(0x0028, 0x0100, "US", us(16)), // BitsAllocated
    el(0x0028, 0x0101, "US", us(16)), // BitsStored
    el(0x0028, 0x0102, "US", us(15)), // HighBit
    el(0x0028, 0x0103, "US", us(1)), // PixelRepresentation: signed (obrigatorio para HU negativo)
    el(0x0028, 0x1050, "DS", "400"), // window center
    el(0x0028, 0x1051, "DS", "400"), // window width
    el(0x0028, 0x1054, "LO", "HU"), // rescale type

    // --- Position / orientation ---
    el(0x0020, 0x0032, "DS", ds("-8.0", "-8.0", "-45.0")),
    // ImageOrientationPatient tem SEIS valores: direcao da linha e da coluna.
    el(0x0020, 0x0037, "DS", ds("1", "0", "0", "0", "1", "0")),
    el(0x0020, 0x1041, "DS", "-45.0"),

    // --- Rescale (HU = stored * slope + intercept) ---
    el(0x0028, 0x1052, "DS", "1"),
    el(0x0028, 0x1053, "DS", "0"),

    // --- Pixel data (OW, native, uncompressed) ---
    el(0x7fe0, 0x0010, "OW", pixelBytes),
  ],
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(file));

console.log(`escrito: ${OUT}`);
console.log(`bytes: ${file.length}`);
console.log(`matriz: ${COLS}x${ROWS}, slices: 1, transfer syntax: Explicit VR LE`);
