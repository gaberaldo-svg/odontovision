// Testa a matematica de volume e janela/contraste sem DOM e sem browser.
// Roda direto no Node, usando o type-stripping nativo do Node 22
// (--experimental-strip-types), sem compilar nada.
//
//   node --experimental-strip-types scripts/verify-volume.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dicomParser from "dicom-parser";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SAMPLE = join(ROOT, "samples", "phantom-64.dcm");

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label.padEnd(38)} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label.padEnd(38)} ${detail}`);
  }
}

function near(label, actual, expected, tol) {
  check(
    label,
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `= ${actual} (esperado ${expected} +/- ${tol})`,
  );
}

// volume.ts e TypeScript puro (sem enum/namespace), entao o Node carrega
// direto com type-stripping. O import de tipos e apagado em tempo de
// compilacao, entao types.ts nem chega a ser resolvido.
const { huAt, huToGray, autoWindow, storedRange, sliceToImageData, voxelIndex } =
  await import("../lib/dicom/volume.ts");

// --- monta o volume a partir da fixture, como o worker faz ---
const byteArray = new Uint8Array(readFileSync(SAMPLE));
const ds = dicomParser.parseDicom(byteArray);
const rows = ds.uint16("x00280010");
const columns = ds.uint16("x00280011");
const signed = ds.uint16("x00280103") === 1;
const el = ds.elements.x7fe00010;
const view = new DataView(byteArray.buffer, byteArray.byteOffset + el.dataOffset, el.length);
const values = new Int16Array(rows * columns);
for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true);

const volume = {
  values,
  rows,
  columns,
  slices: 1,
  rescaleSlope: Number.parseFloat(ds.string("x00281052")),
  rescaleIntercept: Number.parseFloat(ds.string("x00281053")),
  sliceSpacing: 0.25,
};

console.log(`\nvolume: ${rows}x${columns}x${volume.slices}, ${signed ? "signed" : "unsigned"}\n`);

console.log("-- storedRange (a fixture tem ruido deliberado de +/-5 HU) --");
const range = storedRange(volume);
near("min armazenado", range.min, -900, 5);
near("max armazenado", range.max, 2200, 5);
check("min abaixo do ar nominal", range.min <= -900, `= ${range.min}`);
check("max acima do nucleo nominal", range.max >= 2200, `= ${range.max}`);

console.log("\n-- huAt (leitura de voxel) --");
near("HU centro (32,32)", huAt(volume, 32, 32), 2200, 8);
near("HU casca (32,40)", huAt(volume, 32, 40), 900, 8);
near("HU mole (32,50)", huAt(volume, 32, 50), 120, 8);
near("HU ar (2,2)", huAt(volume, 2, 2), -900, 8);
check("fora dos limites devolve NaN", Number.isNaN(huAt(volume, -1, 0, 0)));
check("x acima devolve NaN", Number.isNaN(huAt(volume, columns, 0, 0)));
check("z acima devolve NaN", Number.isNaN(huAt(volume, 0, 0, 1)));

console.log("\n-- voxelIndex --");
check("indice (0,0,0)", voxelIndex(volume, 0, 0, 0) === 0);
check("indice (2,3,0)", voxelIndex(volume, 2, 3, 0) === 3 * columns + 2);
check("indice fora devolve -1", voxelIndex(volume, 0, 0, 5) === -1);

console.log("\n-- huToGray (regra DICOM) --");
check("abaixo da janela -> 0", huToGray(-2000, 400, 40) === 0, `= ${huToGray(-2000, 400, 40)}`);
check("acima da janela -> 255", huToGray(2000, 400, 40) === 255, `= ${huToGray(2000, 400, 40)}`);
check("no centro da janela -> 127/128", [127, 128].includes(huToGray(40, 400, 40)));
check("meio inferior", huToGray(-60, 400, 40) === 64, `= ${huToGray(-60, 400, 40)}`);
check("meio superior", huToGray(140, 400, 40) === 191, `= ${huToGray(140, 400, 40)}`);
check("ww=0 nao divide por zero", Number.isFinite(huToGray(100, 0, 40)));

console.log("\n-- autoWindow --");
const auto = autoWindow(volume);
check("cobre o volume inteiro", auto.windowWidth > range.max - range.min, JSON.stringify(auto));
check("centro coerente", auto.windowCenter === Math.round((2200 + -900) / 2), `= ${auto.windowCenter}`);

// Osso Geral: ww=4000 wc=500 -> lower = -1500, upper = 2500
// Tecido Mole: ww=400  wc=40  -> lower = -160,  upper = 240
// Os valores esperados sao calculados pela regra DICOM, nao chutados.
console.log("\n-- sliceToImageData / preset Osso Geral (ww 4000, wc 500) --");
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const img = sliceToImageData(volume, 0, 4000, 500, 1);
check("dimensoes 1:1", img.width === 64 && img.height === 64, `${img.width}x${img.height}`);
check("alpha opaco", img.data[3] === 255);
const grayAt = (x, y) => img.data[(y * 64 + x) * 4];
// gray = round((HU + 1500) / 4000 * 255)
check("nucleo 2197 -> 236", grayAt(32, 32) === 236, `= ${grayAt(32, 32)}`);
check("casca 902 -> 153", grayAt(32, 40) === 153, `= ${grayAt(32, 40)}`);
check("mole 120 -> 103", grayAt(32, 50) === 103, `= ${grayAt(32, 50)}`);
check("ar -898 -> 38 (nao e preto nessa janela)", grayAt(2, 2) === 38, `= ${grayAt(2, 2)}`);
check("nucleo bem mais claro que o ar", grayAt(32, 32) - grayAt(2, 2) > 150);
{
  const p = (32 * 64 + 32) * 4;
  check("R = G = B (mono)", img.data[p] === img.data[p + 1] && img.data[p + 1] === img.data[p + 2],
    `${img.data[p]}/${img.data[p + 1]}/${img.data[p + 2]}`);
}

console.log("\n-- sliceToImageData / preset Tecido Mole (ww 400, wc 40) --");
const imgTissue = sliceToImageData(volume, 0, 400, 40, 1);
const grayTissue = (x, y) => imgTissue.data[(y * 64 + x) * 4];
check("ar -898 satura em preto", grayTissue(2, 2) === 0, `= ${grayTissue(2, 2)}`);
check("mole 120 -> 179", grayTissue(32, 50) === 179, `= ${grayTissue(32, 50)}`);
check("nucleo satura em branco", grayTissue(32, 32) === 255, `= ${grayTissue(32, 32)}`);
check("casca satura em branco", grayTissue(32, 40) === 255, `= ${grayTissue(32, 40)}`);

console.log("\n-- sliceToImageData / upscale nearest-neighbor --");
const img4x = sliceToImageData(volume, 0, 4000, 500, 4);
check("upscale 4x", img4x.width === 256 && img4x.height === 256, `${img4x.width}x${img4x.height}`);
// indice correto: (linha * largura + coluna) * 4
const at4x = (x, y) => img4x.data[(y * 256 + x) * 4];
check("bloco 4x do nucleo e uniforme", [0, 1, 2, 3].every((d) => at4x(32 * 4 + d, 32 * 4 + d) === 236), `= ${at4x(128, 128)}`);
// a casca (y=40) deve cair no bloco seguinte, com o valor dela
check("bloco seguinte traz a casca", at4x(32 * 4, 40 * 4) === 153, `= ${at4x(128, 160)}`);
check("sem mistura entre voxels", at4x(32 * 4 + 3, 32 * 4) === at4x(32 * 4 + 2, 32 * 4),
  "bloco 4x e solido");
check("canto 4x preserva o ar", at4x(2 * 4, 2 * 4) === grayAt(2, 2), `= ${at4x(8, 8)}`);
check("upscale 0.5 reduz", (() => {
  const small = sliceToImageData(volume, 0, 4000, 500, 0.5);
  return small.width === 32 && small.height === 32;
})());

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
