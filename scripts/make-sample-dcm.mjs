// Gera um .dcm DICOM Part 10 sintetico e valido, para testes de parsing.
// Explicit VR Little Endian, 1 imagem 64x64 com phantom geometrico.
//
//   node scripts/make-sample-dcm.mjs
//
// A saida vai para samples/ e e git-ignored de proposito: o agente nunca deve
// ler o conteudo binario, so a contagem de arquivos.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "samples", "phantom-64.dcm");
const ROWS = 64;
const COLS = 64;

const enc = new TextEncoder();

const LONG_VRS = new Set(["OB", "OW", "OF", "OD", "OL", "SQ", "UT", "UN", "UC", "UR"]);

/** Elemento DICOM explicit VR little endian. */
function el(group, element, vr, value) {
  const isLong = LONG_VRS.has(vr);

  // header curto = tag(4) + VR(2) + len(2)  -> 8 bytes
  // header longo = tag(4) + VR(2) + reservado(2) + len(4) -> 12 bytes
  const head = new Uint8Array(isLong ? 12 : 8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, element, true);
  head[4] = vr.charCodeAt(0);
  head[5] = vr.charCodeAt(1);

  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (typeof value === "string") {
    bytes = enc.encode(value);
    // strings DICOM sempre ocupam comprimento par (preenchido com espaco)
    if (bytes.length % 2 !== 0) bytes = concat([bytes, new Uint8Array([0x20])]);
  } else {
    bytes = new Uint8Array(0);
  }

  if (isLong) {
    // bytes 6-7 ja sao zero (campo reservado)
    dv.setUint32(8, bytes.length, true);
  } else {
    dv.setUint16(6, bytes.length, true);
  }

  return concat([head, bytes]);
}

function us(value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- Pixel data: phantom geométrico com valores em HU ----
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
const IMPL_CLASS_UID = "1.2.826.0.1.3680043.10.1000.1";
const IMPL_VERSION = "ODONTOVISION_1.0";

const fileMeta = concat([
  el(0x0002, 0x0002, "UI", SOP_CLASS_UID), // MediaStorageSOPClassUID
  el(0x0002, 0x0003, "UI", "1.2.826.0.1.3680043.10.1000.1.1.1"), // MediaStorageSOPInstanceUID
  el(0x0002, 0x0010, "UI", SOP_CLASS_UID), // TransferSyntaxUID = Explicit VR LE
  el(0x0002, 0x0012, "UI", IMPL_CLASS_UID), // ImplementationClassUID
  el(0x0002, 0x0013, "UI", IMPL_VERSION), // ImplementationVersionName
]);

// 128 bytes de padding + "DICM"
const preamble = new Uint8Array(132);
preamble.set(enc.encode("DICM"), 128);

const dataset = concat([
  // --- Patient (anonimizado) ---
  el(0x0008, 0x0005, "CS", "ISO_IR 100"),
  el(0x0008, 0x0008, "CS", "ORIGINAL\\PRIMARY\\AXIAL"),
  el(0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.2"),
  el(0x0008, 0x0018, "UI", "1.2.840.10008.5.1.4.1.1.2.1"),
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
  el(0x0028, 0x0030, "DS", "0.25\\0.25"),
  el(0x0028, 0x0100, "US", us(16)), // BitsAllocated
  el(0x0028, 0x0101, "US", us(16)), // BitsStored
  el(0x0028, 0x0102, "US", us(15)), // HighBit
  el(0x0028, 0x0103, "US", us(1)), // PixelRepresentation: signed (obrigatorio para HU negativo)
  el(0x0028, 0x1050, "DS", "400"), // window center
  el(0x0028, 0x1051, "DS", "400"), // window width
  el(0x0028, 0x1054, "LO", "HU"), // rescale type

  // --- Position / orientation ---
  el(0x0020, 0x0032, "DS", "-102.5\\-102.5\\-45.0"),
  el(0x0020, 0x0037, "DS", "1\\0\\0"),
  el(0x0020, 0x1041, "DS", "-45.0"),

  // --- Rescale (HU = stored * slope + intercept) ---
  el(0x0028, 0x1052, "DS", "1"),
  el(0x0028, 0x1053, "DS", "0"),

  // --- Pixel data (OW, native, uncompressed) ---
  el(0x7fe0, 0x0010, "OW", pixelBytes),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(concat([preamble, fileMeta, dataset])));

console.log(`escrito: ${OUT}`);
console.log(`bytes: ${128 + 4 + fileMeta.length + dataset.length}`);
console.log(`matriz: ${COLS}x${ROWS}, slices: 1, transfer syntax: Explicit VR LE`);
