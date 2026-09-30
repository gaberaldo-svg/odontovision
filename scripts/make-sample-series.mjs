// Gera uma SERIE DICOM de 32 cortes, para testar montagem de volume e MPR.
//
//   node scripts/make-sample-series.mjs
//
// Saida (tudo em samples/, git-ignored):
//   samples/series/slice-000.dcm ... slice-031.dcm   (uma serie multi-arquivo)
//   samples/series-multiframe.dcm                   (a mesma serie em 1 arquivo)
//
// O phantom e deliberadamente 3D e assimétrico:
//  - o raio do nucleo denso CRESCE ao longo de z (6 -> 12 px), entao coronal e
//    sagital mostram um perfil que muda com a altura, diferente do axial;
//  - uma segunda massa densa deslocada em +x e -y, so entre os cortes 8 e 23,
//    desloca o brilho para ~75% da largura no coronal e ~30% no sagital.
// Sem essa assimetria os dois planos ortogonais sairiam identicos e o MPR
// nao teria como ser verificado.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { el, us, ds, buildFile } from "./lib/dicom-writer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "..", "samples");
const SERIES_DIR = join(SAMPLES, "series");
const OUT_MULTIFRAME = join(SAMPLES, "series-multiframe.dcm");

const COLS = 64;
const ROWS = 64;
const SLICES = 32;
const PIXEL_SPACING = 0.25; // mm, em X e em Y
const Z_SPACING = 1.0; // mm entre cortes
const CX = (COLS - 1) / 2;
const CY = (ROWS - 1) / 2;

// valores em HU
const HU_DENSE = 2200;
const HU_SHELL = 900;
const HU_SOFT = 120;
const HU_AIR = -900;

// massa densa deslocada
const BLOB_X = CX + 16; // 47.5
const BLOB_Y = CY - 12; // 19.5
const BLOB_R = 4;
const BLOB_Z0 = 8;
const BLOB_Z1 = 23;

/** Raio do nucleo denso no corte z: cresce linearmente de 6 para 12 px. */
export function denseRadiusAt(z) {
  return 6 + 6 * (z / (SLICES - 1));
}

/**
 * HU do voxel (x, y, z). Ruido deterministico de +/-2 para a textura nao ficar
 * chapada sem debilitating os asserts (que toleram 3 HU).
 */
export function huAtVoxel(x, y, z) {
  let hu;
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
  return hu + (((x * 7 + y * 13 + z * 29) % 5) - 2);
}

/** Volume completo em ordem [z][y][x]. */
function buildVolume() {
  const values = new Int16Array(COLS * ROWS * SLICES);
  for (let z = 0; z < SLICES; z++) {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        values[z * ROWS * COLS + y * COLS + x] = huAtVoxel(x, y, z);
      }
    }
  }
  return values;
}

const SOP_CLASS_UID = "1.2.840.10008.5.1.4.1.1.2"; // CT Image Storage
const IMPL_CLASS_UID = "1.2.826.0.1.3680043.10.1000.1";
const IMPL_VERSION = "ODONTOVISION_1.0";
const STUDY_UID = "1.2.826.0.1.3680043.10.1000.2.1";
const SERIES_UID = "1.2.826.0.1.3680043.10.1000.2.1.1";
const sopUid = (i) => `1.2.826.0.1.3680043.10.1000.2.1.${i + 1}`;

/** Elementos comuns a todos os cortes. */
function sharedDataset() {
  return [
    el(0x0008, 0x0005, "CS", "ISO_IR 100"),
    el(0x0008, 0x0008, "CS", "ORIGINAL\\PRIMARY\\AXIAL"),
    el(0x0008, 0x0016, "UI", SOP_CLASS_UID),
    el(0x0008, 0x0020, "DA", "20240315"),
    el(0x0008, 0x0030, "TM", "101500"),
    el(0x0008, 0x0060, "CS", "CT"),
    el(0x0008, 0x0070, "LO", "ODONTOPEDIA"),
    el(0x0010, 0x0010, "PN", "ANONIMO^CBCT"),
    el(0x0010, 0x0020, "LO", "CBCT-2024-0142"),
    el(0x0010, 0x0040, "CS", "O"),

    el(0x0020, 0x000d, "UI", STUDY_UID), // StudyInstanceUID
    el(0x0020, 0x000e, "UI", SERIES_UID), // SeriesInstanceUID
    el(0x0020, 0x0010, "SH", "1"), // StudyID
    el(0x0020, 0x0011, "IS", "1"), // SeriesNumber
    el(0x0008, 0x103e, "LO", "CBCT - Mandibula"),
    el(0x0008, 0x1030, "LO", "AXIAL"),
    el(0x0008, 0x1090, "LO", "Philips Brilliance"),

    el(0x0018, 0x0050, "DS", ds(Z_SPACING.toFixed(1))), // SliceThickness
    el(0x0018, 0x0088, "DS", ds(Z_SPACING.toFixed(1))), // SpacingBetweenSlices
    el(0x0020, 0x1040, "LO", "HFS"),

    el(0x0028, 0x0002, "US", us(1)), // SamplesPerPixel
    el(0x0028, 0x0004, "CS", "MONOCHROME2"),
    el(0x0028, 0x0010, "US", us(ROWS)),
    el(0x0028, 0x0011, "US", us(COLS)),
    el(0x0028, 0x0030, "DS", ds(PIXEL_SPACING.toFixed(2), PIXEL_SPACING.toFixed(2))),
    el(0x0028, 0x0100, "US", us(16)), // BitsAllocated
    el(0x0028, 0x0101, "US", us(16)), // BitsStored
    el(0x0028, 0x0102, "US", us(15)), // HighBit
    el(0x0028, 0x0103, "US", us(1)), // PixelRepresentation signed -> HU negativo
    el(0x0028, 0x1050, "DS", "450"), // window center
    el(0x0028, 0x1051, "DS", "2000"), // window width
    el(0x0028, 0x1054, "LO", "HU"), // rescale type

    el(0x0028, 0x1052, "DS", "1"), // rescale slope
    el(0x0028, 0x1053, "DS", "0"), // rescale intercept
  ];
}

function buildSlice(index, values) {
  const plane = values.subarray(index * ROWS * COLS, (index + 1) * ROWS * COLS);
  const zPos = -16.0 + index * Z_SPACING;
  return buildFile(
    {
      sopClassUid: SOP_CLASS_UID,
      sopInstanceUid: sopUid(index),
      transferSyntaxUid: "1.2.840.10008.1.2.1", // Explicit VR Little Endian
      implClassUid: IMPL_CLASS_UID,
      implVersion: IMPL_VERSION,
    },
    [
      ...sharedDataset(),
      el(0x0008, 0x0018, "UI", sopUid(index)), // SOPInstanceUID
      el(0x0020, 0x0013, "IS", String(index + 1)), // InstanceNumber
      el(0x0028, 0x0008, "IS", "1"), // NumberOfFrames
      // ImageOrientationPatient tem SEIS valores: 3 da direcao da linha
      // (X) e 3 da coluna (Y).
      el(0x0020, 0x0037, "DS", ds("1", "0", "0", "0", "1", "0")),
      el(0x0020, 0x0032, "DS", ds("-8.0", "-8.0", zPos.toFixed(1))),
      el(0x0020, 0x1041, "DS", ds(zPos.toFixed(1))),
      el(0x7fe0, 0x0010, "OW", new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength)),
    ],
  );
}

function buildMultiFrame(values) {
  // NumberOfFrames IS precisa vir antes do pixel data e o pixel data e OW.
  const all = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  return buildFile(
    {
      sopClassUid: SOP_CLASS_UID,
      sopInstanceUid: "1.2.826.0.1.3680043.10.1000.2.1.999",
      transferSyntaxUid: "1.2.840.10008.1.2.1",
      implClassUid: IMPL_CLASS_UID,
      implVersion: IMPL_VERSION,
    },
    [
      ...sharedDataset(),
      el(0x0008, 0x0018, "UI", "1.2.826.0.1.3680043.10.1000.2.1.999"),
      el(0x0020, 0x0013, "IS", "1"), // InstanceNumber
      el(0x0028, 0x0008, "IS", String(SLICES)),
      el(0x0020, 0x0037, "DS", ds("1", "0", "0", "0", "1", "0")),
      el(0x0020, 0x0032, "DS", ds("-8.0", "-8.0", "-16.0")),
      el(0x7fe0, 0x0010, "OW", all),
    ],
  );
}

function main() {
  const values = buildVolume();

  rmSync(SERIES_DIR, { recursive: true, force: true });
  mkdirSync(SERIES_DIR, { recursive: true });

  let bytesTotal = 0;
  for (let i = 0; i < SLICES; i++) {
    const bytes = buildSlice(i, values);
    bytesTotal += bytes.length;
    const name = `slice-${String(i).padStart(3, "0")}.dcm`;
    writeFileSync(join(SERIES_DIR, name), Buffer.from(bytes));
  }
  writeFileSync(OUT_MULTIFRAME, Buffer.from(buildMultiFrame(values)));

  console.log(`serie: ${SLICES} cortes em ${SERIES_DIR}`);
  console.log(`matriz: ${COLS}x${ROWS}x${SLICES}, pixel ${PIXEL_SPACING}mm, z ${Z_SPACING}mm`);
  console.log(`bytes: ${bytesTotal} (serie) | ${values.byteLength * 2} (payload multi-frame)`);
  console.log(`raio do nucleo: ${denseRadiusAt(0).toFixed(1)} -> ${denseRadiusAt(SLICES - 1).toFixed(1)} px`);
}

// Só gera quando chamado direto (npm run sample:series). Importar o modulo
// para reusar huAtVoxel/denseRadiusAt nos testes não deve tocar o disco.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
