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

// ---------------------------------------------------------------------------
// MPR: geometria dos tres planos
//
// Usamos um volume sintetico minúsculo com valor = 100*z + 10*y + x, que
// torna qualquer erro de permutacao de eixo visivel: cada voxel tem um valor
// unico, entao ler a coordenada errada da um numero errado.
// ---------------------------------------------------------------------------

console.log("\n== MPR ==");

const {
  planeDimensions,
  planeAspect,
  zAspect,
  voxelFromPlane,
  planeFromVoxel,
  planeSliceCount,
  planeHuAt,
  planeSliceToImageData,
  voxelSizeMm,
} = await import("../lib/dicom/volume.ts");

const COLS = 8;
const ROWS = 6;
const SLICES = 4;
const mprValues = new Int16Array(COLS * ROWS * SLICES);
for (let z = 0; z < SLICES; z++) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      mprValues[z * ROWS * COLS + y * COLS + x] = 100 * z + 10 * y + x;
    }
  }
}

// pixel 0.5mm em X/Y e cortes a 2mm: cada corte vale 4 linhas no eixo vertical
// dos planos MPR.
const mprVolume = {
  values: mprValues,
  rows: ROWS,
  columns: COLS,
  slices: SLICES,
  rescaleSlope: 1,
  rescaleIntercept: 0,
  sliceSpacing: 2,
  pixelSpacing: [0.5, 0.5],
};

console.log("\n-- dimensoes dos planos --");
check("axial: columns x rows", JSON.stringify(planeDimensions(mprVolume, "axial")) === JSON.stringify({ columns: 8, rows: 6 }),
  JSON.stringify(planeDimensions(mprVolume, "axial")));
check("coronal: columns x slices", JSON.stringify(planeDimensions(mprVolume, "coronal")) === JSON.stringify({ columns: 8, rows: 4 }),
  JSON.stringify(planeDimensions(mprVolume, "coronal")));
check("sagital: rows x slices", JSON.stringify(planeDimensions(mprVolume, "sagital")) === JSON.stringify({ columns: 6, rows: 4 }),
  JSON.stringify(planeDimensions(mprVolume, "sagital")));

console.log("\n-- indice de cada plano --");
check("axial tem slices cortes", planeSliceCount(mprVolume, "axial") === 4);
check("coronal tem rows cortes", planeSliceCount(mprVolume, "coronal") === 6);
check("sagital tem columns cortes", planeSliceCount(mprVolume, "sagital") === 8);

console.log("\n-- aspecto em Z (a correcao que evita o MPR achatado) --");
near("zAspect = 2mm / 0.5mm", zAspect(mprVolume), 4, 1e-9);
check("axial nao distorce (aspecto 1)",
  (() => {
    const img = planeSliceToImageData(mprVolume, "axial", 0, 4000, 500, 2);
    return img.width === 16 && img.height === 12;
  })(),
  "16x12 = 8*2 x 6*2");
check("coronal corrige o eixo vertical por zAspect",
  (() => {
    const img = planeSliceToImageData(mprVolume, "coronal", 0, 4000, 500, 2);
    return img.width === 16 && img.height === 32;
  })(),
  "16x32 = 8*2 x (4*2*4)");
check("sagital corrige o eixo vertical por zAspect",
  (() => {
    const img = planeSliceToImageData(mprVolume, "sagital", 0, 4000, 500, 2);
    return img.width === 12 && img.height === 32;
  })(),
  "12x32 = 6*2 x (4*2*4)");
check("zAspect sem pixelSpacing nao quebra", zAspect({ ...mprVolume, pixelSpacing: null }) === 1);

console.log("\n-- aspect por plano: fonte unica entre desenho e cursor --");
// Regressao de um bug real: o canvas calculava `scale` com zAspect direto
// enquanto o render usava aspecto 1 no axial. O `scale` do axial saia
// dividido por 4 e a imagem encolhia para um quarto do tamanho, sem erro
// nenhum na tela -- so o MPR ficava errado. `planeAspect` elimina a
// duplicacao que permitiu a divergencia.
check("axial: aspecto 1", planeAspect(mprVolume, "axial") === 1, `= ${planeAspect(mprVolume, "axial")}`);
near("coronal: aspecto = zAspect", planeAspect(mprVolume, "coronal"), 4, 1e-9);
near("sagittal: aspecto = zAspect", planeAspect(mprVolume, "sagittal"), 4, 1e-9);
check("sem pixelSpacing o aspecto cai para 1",
  planeAspect({ ...mprVolume, pixelSpacing: null }, "coronal") === 1);

// O `scale` do canvas sai de max(columns, rows*aspect). A imagem precisa ter
// exatamente essa proporcao, senao o cursor aponta para fora da figura.
for (const plane of ["axial", "coronal", "sagittal"]) {
  const { columns, rows } = planeDimensions(mprVolume, plane);
  const aspect = planeAspect(mprVolume, plane);
  const img = planeSliceToImageData(mprVolume, plane, 0, 4000, 500, 3);
  const largura = columns * 3;
  const altura = Math.round(rows * 3 * aspect);
  check(`${plane}: imagem ${largura}x${altura} (columns*3 x rows*3*aspect)`,
    img.width === largura && img.height === altura, `veio ${img.width}x${img.height}`);
}

console.log("\n-- voxelFromPlane / planeFromVoxel sao inversas --");
for (const plane of ["axial", "coronal", "sagital"]) {
  let ok = true;
  for (let i = 0; i < planeSliceCount(mprVolume, plane); i++) {
    const { columns, rows } = planeDimensions(mprVolume, plane);
    for (let u = 0; u < columns; u++) {
      for (let v = 0; v < rows; v++) {
        const vox = voxelFromPlane(plane, i, u, v);
        const back = planeFromVoxel(plane, vox.x, vox.y, vox.z);
        if (back.index !== i || back.u !== u || back.v !== v) ok = false;
      }
    }
  }
  check(`round-trip em ${plane}`, ok);
}

console.log("\n-- cada plano le o voxel certo --");
// voxel(3,2,1) = 100*1 + 10*2 + 3 = 123
check("axial fixo z=1, u=x=3, v=y=2", planeHuAt(mprVolume, "axial", 1, 3, 2) === 123,
  `= ${planeHuAt(mprVolume, "axial", 1, 3, 2)}`);
// coronal fixo y=2, u=x=3, v=z=1
check("coronal fixo y=2, u=x=3, v=z=1", planeHuAt(mprVolume, "coronal", 2, 3, 1) === 123,
  `= ${planeHuAt(mprVolume, "coronal", 2, 3, 1)}`);
// sagital fixo x=3, u=y=2, v=z=1
check("sagital fixo x=3, u=y=2, v=z=1", planeHuAt(mprVolume, "sagital", 3, 2, 1) === 123,
  `= ${planeHuAt(mprVolume, "sagital", 3, 2, 1)}`);

console.log("\n-- os tres planos nao sao a mesma imagem --");
{
  // Janela fina: com ww 4000 os valores 113 e 123 arredondam para o mesmo
  // cinza e a comparacao fica cega. ww 200 separa 10 HU em ~13 niveis.
  const WW = 200;
  const WC = 150;
  const grayOf = (img, x, y) => img.data[(y * img.width + x) * 4];
  const a = planeSliceToImageData(mprVolume, "axial", 1, WW, WC, 1);
  const c = planeSliceToImageData(mprVolume, "coronal", 1, WW, WC, 1);
  const s = planeSliceToImageData(mprVolume, "sagital", 1, WW, WC, 1);

  // No mesmo (u,v)=(3,1) e mesmo indice 1:
  //   axial   -> x=3, y=1, z=1 -> 113
  //   coronal -> x=3, y=1, z=1 -> 113 (coincide por construcao)
  //   sagital -> x=1, y=3, z=1 -> 131 (permuta x/y)
  check("axial le 113 em (1,3,1)", planeHuAt(mprVolume, "axial", 1, 3, 1) === 113,
    `= ${planeHuAt(mprVolume, "axial", 1, 3, 1)}`);
  check("sagital le 131 em (1,3,1)", planeHuAt(mprVolume, "sagital", 1, 3, 1) === 131,
    `= ${planeHuAt(mprVolume, "sagital", 1, 3, 1)}`);

  const va = grayOf(a, 3, 1);
  const vc = grayOf(c, 3, 1 * 4); // v=1 => linha 1*aspect(4)
  const vs = grayOf(s, 3, 1 * 4);
  check("render axial = 113", va === Math.round(((113 - 50) / WW) * 255), `= ${va}`);
  check("render coronal = 113", vc === Math.round(((113 - 50) / WW) * 255), `= ${vc}`);
  check("render sagital = 131", vs === Math.round(((131 - 50) / WW) * 255), `= ${vs}`);
  check("axial == coronal nesse ponto", va === vc, `${va} vs ${vc}`);
  check("sagital difere dos outros", vs !== va && vs !== vc, `${vs} vs ${va}/${vc}`);

  // E o conteudo geral das tres imagens tambem difere.
  const signature = (img) => {
    let sum = 0;
    for (let i = 0; i < img.data.length; i += 4) sum += img.data[i];
    return sum;
  };
  check("soma de cinzas coronal != sagital", signature(c) !== signature(s),
    `${signature(c)} vs ${signature(s)}`);
}

console.log("\n-- voxelSizeMm --");
const mm = voxelSizeMm(mprVolume);
check("x/y/z em mm", mm.x === 0.5 && mm.y === 0.5 && mm.z === 2, JSON.stringify(mm));
check("z usa sliceSpacing, nao pixelSpacing", mm.z === 2, "o bug antigo devolvia 0.5");

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
