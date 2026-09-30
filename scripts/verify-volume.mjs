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
const { huAt, huToGray, autoWindow, storedRange, sliceToImageData, voxelIndex, planeVoxelSizeMm, planeDistanceMm, planeAngleDeg } =
  await import("../lib/dicom/volume.ts");
const { buildMeasurement, buildAngleMeasurement } = await import("../lib/dicom/measure.ts");
const { buildReport } = await import("../lib/dicom/report.ts");
const { buildAnnotation, sanitizeAnnotationText, MAX_ANNOTATION_CHARS } =
  await import("../lib/dicom/annotate.ts");

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

console.log("\n-- planeVoxelSizeMm: cada plano usa o eixo certo --");
near("axial u = x", planeVoxelSizeMm(mprVolume, "axial").u, 0.5, 1e-9);
near("axial v = y", planeVoxelSizeMm(mprVolume, "axial").v, 0.5, 1e-9);
near("coronal u = x", planeVoxelSizeMm(mprVolume, "coronal").u, 0.5, 1e-9);
check("coronal v = z", planeVoxelSizeMm(mprVolume, "coronal").v === 2,
  `= ${planeVoxelSizeMm(mprVolume, "coronal").v}`);
near("sagital u = y", planeVoxelSizeMm(mprVolume, "sagital").u, 0.5, 1e-9);
check("sagital v = z", planeVoxelSizeMm(mprVolume, "sagital").v === 2,
  `= ${planeVoxelSizeMm(mprVolume, "sagital").v}`);

// A fixture MPR e 0,5 mm nos dois eixos da imagem e 2 mm entre cortes, e tem
// 8x6x4 voxels. As medidas abaixo sao triplos pitagoricos multiplicados por
// 0,5: nao ha numero magico, so a conta.
console.log("\n-- planeDistanceMm: Pitagoras com cada eixo em mm --");
// axial (8x6): du 3 voxels = 1,5 mm, dv 4 voxels = 2,0 mm -> 2,5 mm.
near("axial 3,4 voxels = 2,5 mm", planeDistanceMm(mprVolume, "axial", { u: 0, v: 0 }, { u: 3, v: 4 }), 2.5, 1e-9);
// O eixo v do coronal e z, que vale 2 mm e nao 0,5: 3 voxels = 6 mm. Com
// pixelSpacing nos dois eixos daria 1,5 mm, 4x menor -- o deslize a acertar.
near("coronal 3 voxels em v = 6 mm", planeDistanceMm(mprVolume, "coronal", { u: 0, v: 0 }, { u: 0, v: 3 }), 6, 1e-9);
near("sagital 3 voxels em v = 6 mm", planeDistanceMm(mprVolume, "sagital", { u: 0, v: 0 }, { u: 0, v: 3 }), 6, 1e-9);
// Eixo misto no coronal: 3 em u (1,5 mm) e 2 em v (4,0 mm) -> 4,27 mm.
near("coronal misto", planeDistanceMm(mprVolume, "coronal", { u: 0, v: 0 }, { u: 3, v: 2 }),
  Math.hypot(3 * 0.5, 2 * 2), 1e-9);
near("simetria", planeDistanceMm(mprVolume, "coronal", { u: 0, v: 3 }, { u: 0, v: 0 }), 6, 1e-9);
check("mesmo ponto = 0 mm", planeDistanceMm(mprVolume, "axial", { u: 7, v: 5 }, { u: 7, v: 5 }) === 0);
check("um voxel em x = 0,5 mm", planeDistanceMm(mprVolume, "axial", { u: 0, v: 0 }, { u: 1, v: 0 }) === 0.5);
// Sem sliceSpacing nem pixelSpacing a leitura cai em 1 mm por voxel.
near("fallback isotropico", planeDistanceMm({ ...mprVolume, pixelSpacing: undefined, sliceSpacing: undefined },
  "coronal", { u: 0, v: 0 }, { u: 3, v: 3 }), Math.hypot(3, 3), 1e-9);

console.log("\n-- buildMeasurement: geometria e arredondamento --");
{
  const ok = buildMeasurement(mprVolume, "axial", 1, { u: 0, v: 1 }, { u: 3, v: 5 }, 7);
  check("aceita dois pontos validos", ok.ok === true, JSON.stringify(ok));
  check("guarda plano, corte e id", ok.ok && ok.measurement.plane === "axial"
    && ok.measurement.slice === 1 && ok.measurement.id === 7);
  // 1,5 mm e 2,0 mm: a soma das casas da 2,5 mm exatos, sem digito inventado.
  check("2,50 mm", ok.ok && ok.measurement.distanceMm === 2.5,
    `= ${ok.ok ? ok.measurement.distanceMm : ok.error}`);
  // sqrt(0,5^2 + 0,5^2) = 0,7071: e aqui que as duas casas aparecem.
  check("arredonda para duas casas",
    buildMeasurement(mprVolume, "axial", 0, { u: 0, v: 0 }, { u: 1, v: 1 }, 1).measurement.distanceMm === 0.71,
    `= ${buildMeasurement(mprVolume, "axial", 0, { u: 0, v: 0 }, { u: 1, v: 1 }, 1).measurement.distanceMm}`);

  const igual = buildMeasurement(mprVolume, "axial", 1, { u: 4, v: 4 }, { u: 4, v: 4 }, 1);
  check("recusa ponto igual", igual.ok === false && igual.error === "ponto-igual", JSON.stringify(igual));

  const fora = buildMeasurement(mprVolume, "axial", 1, { u: 0, v: 0 }, { u: 999, v: 0 }, 1);
  check("recusa ponto fora do plano", fora.ok === false && fora.error === "fora-do-plano", JSON.stringify(fora));
  const foraV = buildMeasurement(mprVolume, "axial", 1, { u: 0, v: 999 }, { u: 0, v: 1 }, 1);
  check("recusa v fora do plano", foraV.ok === false && foraV.error === "fora-do-plano");
  // O axial tem 6 linhas e o coronal so 4: o mesmo v passa num e nao no outro.
  check("recusa v que so cabe no axial", buildMeasurement(mprVolume, "coronal", 0, { u: 0, v: 5 }, { u: 0, v: 1 }, 1).ok === false);
  check("aceita o mesmo v no axial", buildMeasurement(mprVolume, "axial", 0, { u: 0, v: 5 }, { u: 0, v: 1 }, 1).ok === true);
  check("recusa ponto fracionario", buildMeasurement(mprVolume, "axial", 0, { u: 0, v: 0 }, { u: 1.5, v: 0 }, 1).ok === false);
  check("recusa ponto negativo", buildMeasurement(mprVolume, "axial", 0, { u: -1, v: 0 }, { u: 1, v: 0 }, 1).ok === false);
}

console.log("\n-- buildMeasurement le HU dos dois pontos --");
// A fixture MPR grava 100*z + 10*y + x, entao o HU de qualquer ponto e
// conferivel na mao. Estes sao os pontos da medida de 2,5 mm acima.
{
  // axial no corte 1: u=x, v=y -> (0,1) = 100 + 10 = 110; (3,5) = 100 + 50 + 3 = 153
  const m = buildMeasurement(mprVolume, "axial", 1, { u: 0, v: 1 }, { u: 3, v: 5 }, 1).measurement;
  check("HU da ponta A", m.huA === 110, `= ${m.huA}`);
  check("HU da ponta B", m.huB === 153, `= ${m.huB}`);
  check("delta = B - A", m.deltaHu === 43, `= ${m.deltaHu}`);
  check("delta bate com as pontas", m.deltaHu === m.huB - m.huA);

  // Inverter as pontas inverte o delta e mantem o comprimento: a medida nao
  // depende da ordem, so a leitura do sinal.
  const r = buildMeasurement(mprVolume, "axial", 1, { u: 3, v: 5 }, { u: 0, v: 1 }, 2).measurement;
  check("inverter pontas mantem o mm", r.distanceMm === m.distanceMm);
  check("inverter pontas inverte o delta", r.deltaHu === -m.deltaHu, `= ${r.deltaHu}`);

  // O HU e lido no CORTE da medida, nao no corte 0: o mesmo (u,v) no axial 0
  // vale 10 + x, no axial 1 vale 100 + 10 + x. Ler no corte errado erraria em
  // 100 HU sem nenhum sinal na tela.
  check("HU usa o corte da medida", m.huA === 110 && m.huA !== 10,
    `corte 1 = ${m.huA}, corte 0 seria 10`);

  // Cada plano le seu proprio (u,v): no coronal (0,1) com y=0 e x=0 -> z=1 -> 100.
  const c = buildMeasurement(mprVolume, "coronal", 0, { u: 0, v: 1 }, { u: 3, v: 2 }, 3).measurement;
  check("HU no coronal le x e z", c.huA === 100 && c.huB === 203,
    `A=${c.huA} B=${c.huB}`);
  // Sagital com x=0: (u,v) = (y,z), y=1 -> 10 + z=1 -> 110.
  const s = buildMeasurement(mprVolume, "sagital", 0, { u: 1, v: 1 }, { u: 5, v: 3 }, 4).measurement;
  check("HU no sagital le y e z", s.huA === 110 && s.huB === 350,
    `A=${s.huA} B=${s.huB}`);

  // A mesma medida no volume real da serie: rescale entra na conta.
  const comSlope = buildMeasurement(
    { ...mprVolume, rescaleSlope: 2, rescaleIntercept: -1024 },
    "axial", 1, { u: 0, v: 1 }, { u: 3, v: 5 }, 5).measurement;
  check("HU respeita slope/intercept", comSlope.huA === (110 * 2 - 1024) && comSlope.huB === (153 * 2 - 1024),
    `A=${comSlope.huA} B=${comSlope.huB}`);
  // O delta e a diferenca ja com o rescale aplicado, nao o stored bruto.
  check("delta usa HU ja convertido", comSlope.deltaHu === comSlope.huB - comSlope.huA
    && comSlope.deltaHu === (153 - 110) * 2, `= ${comSlope.deltaHu}`);
}

console.log("\n-- planeAngleDeg: o angulo e em mm, nao em voxel --");
// Fixture: pixelSpacing 0,5 e sliceSpacing 2,0. No coronal/sagital a grade e
// 4x mais alta que larga, entao a mesma tripla de voxels dá angulos muito
// diferentes conforme o plano. E o teste que pega o calculo em voxel: o
// resultado errado (126,9 no axial) e plausivel demais para chamar atencao.
const tripla = { a: { u: 7, v: 3 }, b: { u: 3, v: 1 }, c: { u: 1, v: 2 } };
near("axial: grade isotropica", planeAngleDeg(mprVolume, "axial", tripla.a, tripla.b, tripla.c), 126.9, 0.05);
near("coronal: v esticado 4x muda o angulo", planeAngleDeg(mprVolume, "coronal", tripla.a, tripla.b, tripla.c), 53.1, 0.05);
check("coronal difere do axial (seria 126,9 em voxel)", 
  planeAngleDeg(mprVolume, "coronal", tripla.a, tripla.b, tripla.c)
    !== planeAngleDeg(mprVolume, "axial", tripla.a, tripla.b, tripla.c));

// Angulo reto exato: e o caso em que `acos` quebra, porque o produto
// arredonda para um valor acima da norma dos vetores e devolve NaN.
const reto = { a: { u: 7, v: 1 }, b: { u: 3, v: 1 }, c: { u: 3, v: 2 } };
near("angulo reto exato no coronal", planeAngleDeg(mprVolume, "coronal", reto.a, reto.b, reto.c), 90, 0.05);
check("reto nao devolve NaN", Number.isFinite(planeAngleDeg(mprVolume, "coronal", reto.a, reto.b, reto.c)));

// Colinear: 0 e 180 sao angulos legitimos -- e assim que se confere "isto aqui
// esta reto". Nao sao erro.
near("mesma direcao = 0 graus",
  planeAngleDeg(mprVolume, "axial", { u: 4, v: 1 }, { u: 3, v: 1 }, { u: 5, v: 1 }), 0, 0.05);
near("direcoes opostas = 180 graus",
  planeAngleDeg(mprVolume, "axial", { u: 2, v: 1 }, { u: 3, v: 1 }, { u: 4, v: 1 }), 180, 0.05);

console.log("\n-- buildAngleMeasurement --");
const angAx = buildAngleMeasurement(mprVolume, "axial", 1, { u: 7, v: 3 }, { u: 3, v: 1 }, { u: 1, v: 2 }, 11);
check("axial aceita", angAx.ok === true);
check("kind = angle", angAx.ok && angAx.measurement.kind === "angle");
near("graus com uma casa", angAx.ok && angAx.measurement.angleDeg, 126.9, 0.05);
check("guarda os tres pontos", angAx.ok
  && angAx.measurement.a.u === 7 && angAx.measurement.b.u === 3 && angAx.measurement.c.u === 1);
// Sem `deltaHu`: com tres pontos nao existe par unico, e um delta escolhido
// por conta propria seria um numero que ninguem pediu.
check("angulo nao tem deltaHu", angAx.ok && !("deltaHu" in angAx.measurement));

// HU dos tres pontos, pelo mesmo caminho do readout (HU = 100z + 10y + x).
check("HU dos tres pontos no axial", angAx.ok
  && angAx.measurement.huA === 137 && angAx.measurement.huB === 113 && angAx.measurement.huC === 121,
  angAx.ok ? `A=${angAx.measurement.huA} B=${angAx.measurement.huB} C=${angAx.measurement.huC}` : "recusado");

const angCor = buildAngleMeasurement(mprVolume, "coronal", 0, { u: 7, v: 3 }, { u: 3, v: 1 }, { u: 1, v: 2 }, 12);
near("coronal: 53,1 e nao os 126,9 da grade", angCor.ok && angCor.measurement.angleDeg, 53.1, 0.05);
check("HU dos tres pontos no coronal", angCor.ok
  && angCor.measurement.huA === 307 && angCor.measurement.huB === 103 && angCor.measurement.huC === 201,
  angCor.ok ? `A=${angCor.measurement.huA} B=${angCor.measurement.huB} C=${angCor.measurement.huC}` : "recusado");

const angSag = buildAngleMeasurement(mprVolume, "sagital", 0, { u: 4, v: 3 }, { u: 2, v: 1 }, { u: 0, v: 2 }, 13);
near("sagital com os proprios eixos", angSag.ok && angSag.measurement.angleDeg, 40.6, 0.05);
check("HU no sagital le y e z", angSag.ok
  && angSag.measurement.huA === 340 && angSag.measurement.huB === 120 && angSag.measurement.huC === 200,
  angSag.ok ? `A=${angSag.measurement.huA} B=${angSag.measurement.huB} C=${angSag.measurement.huC}` : "recusado");

// Rescale entra nos tres pontos.
const angSlope = buildAngleMeasurement(
  { ...mprVolume, rescaleSlope: 2, rescaleIntercept: -1024 },
  "axial", 1, { u: 7, v: 3 }, { u: 3, v: 1 }, { u: 1, v: 2 }, 14);
check("HU do angulo respeita slope/intercept", angSlope.ok
  && angSlope.measurement.huA === 137 * 2 - 1024 && angSlope.measurement.huC === 121 * 2 - 1024,
  angSlope.ok ? `A=${angSlope.measurement.huA} C=${angSlope.measurement.huC}` : "recusado");

// Braco de tamanho zero: o angulo nao existe.
check("vertice igual a ponta A e recusado",
  buildAngleMeasurement(mprVolume, "axial", 1, { u: 3, v: 1 }, { u: 3, v: 1 }, { u: 5, v: 3 }, 1).error === "vertice-igual");
check("vertice igual a ponta C e recusado",
  buildAngleMeasurement(mprVolume, "axial", 1, { u: 1, v: 1 }, { u: 3, v: 3 }, { u: 3, v: 3 }, 1).error === "vertice-igual");
check("pontas iguais entre si e recusado",
  buildAngleMeasurement(mprVolume, "axial", 1, { u: 1, v: 1 }, { u: 3, v: 3 }, { u: 1, v: 1 }, 1).error === "vertice-igual");
// Fora do plano: v=4 nao existe no coronal (4 cortes).
check("v que so cabe no axial e recusado",
  buildAngleMeasurement(mprVolume, "coronal", 0, { u: 0, v: 5 }, { u: 1, v: 1 }, { u: 2, v: 2 }, 1).error === "fora-do-plano");
check("ponto fracionario e recusado",
  buildAngleMeasurement(mprVolume, "axial", 1, { u: 0.5, v: 1 }, { u: 1, v: 1 }, { u: 2, v: 2 }, 1).error === "fora-do-plano");
// A regua e o angulo sao tipos distintos: o `kind` e o que separa.
check("regua continua sendo 'distance'",
  buildMeasurement(mprVolume, "axial", 1, { u: 0, v: 1 }, { u: 3, v: 5 }, 7).measurement.kind === "distance");

console.log("\n-- buildReport: o relatorio lista o exame inteiro --");
const reportMeta = {
  patientName: "MARIA, JOAO",
  patientId: "CBCT-2024-0142",
  studyDate: "2024-03-15",
  seriesDescription: "CBCT - Maxilar Superior",
  modality: "CT",
  voxelSize: [0.25, 0.25, 1],
};
const dist = buildMeasurement(mprVolume, "axial", 1, { u: 0, v: 1 }, { u: 3, v: 5 }, 1).measurement;
const ang = buildAngleMeasurement(mprVolume, "coronal", 0, { u: 7, v: 3 }, { u: 3, v: 1 }, { u: 1, v: 2 }, 2).measurement;
const notaA = buildAnnotation(mprVolume, "coronal", 0, 5, 2, "Canal mandibular", 1).annotation;
const notaB = buildAnnotation(mprVolume, "axial", 1, 2, 4, 'Sinfise, "parte" central', 2).annotation;
// De proposito fora de ordem: a ordem do relatorio e axial -> coronal ->
// sagital, e nao a ordem em que o usuario clicou.
const rel = buildReport([ang, dist], [notaB, notaA], reportMeta);
check("contagem", rel.contagem.medicoes === 2 && rel.contagem.anotacoes === 2,
  JSON.stringify(rel.contagem));

const linhasCsv = rel.csv.trim().split("\n");
check("CSV: cabecalho + 4 linhas", linhasCsv.length === 5, `n=${linhasCsv.length}`);
check("CSV: cabecalho", linhasCsv[0] === '"id","tipo","plano","corte","valor","unidade","hu_a","hu_b","hu_c","delta_hu","texto","u","v"',
  linhasCsv[0]);
// Regra distancia: o valor e numero cru (2.50 -> "2.5"), sem "mm" na celula, e
// texto/u/v vazios -- a geometria dela ja esta no valor e nas pontas.
check("CSV: distancia com valor cru e texto vazio",
  linhasCsv[1] === '"1","distancia","axial","1","2.5","mm","110","153","","43","","",""', linhasCsv[1]);
// Regra angulo: hu_c preenchido e delta vazio, porque o angulo nao tem delta.
check("CSV: angulo com hu_c e sem delta",
  linhasCsv[2] === '"2","angulo","coronal","0","53.1","deg","307","103","201","","","",""', linhasCsv[2]);
// Regra anotacao: valor/unidade/HU vazios, texto e ponto preenchidos. Uma
// anotacao com valor 0 seria mentira: nao ha valor medido. A ordem e
// axial -> coronal (a mesma das medicoes), nao a de insercao.
check("CSV: anotacao do axial so com texto e ponto",
  linhasCsv[3] === '"2","anotacao","axial","1","","","","","","","Sinfise, ""parte"" central","2","4"',
  linhasCsv[3]);
check("CSV: anotacao do coronal", linhasCsv[4] === '"1","anotacao","coronal","0","","","","","","","Canal mandibular","5","2"',
  linhasCsv[4]);
// Aspas dentro do texto: dobradas, senao a celula fecharia no meio e as
// colunas seguintes virariamMeasurements.
check("CSV: aspas do texto dobradas", rel.csv.includes('""parte""'), rel.csv.split("\n")[3]);
check("CSV: nenhuma celula quebra a contagem de colunas",
  linhasCsv.every((l) => (l.match(/"/g) ?? []).length % 2 === 0));

// O relatorio nao esconde o que o usuario mediu: a lista da tela e por corte,
// o relatorio e do exame inteiro.
const soDoCorte = buildReport([dist], [], reportMeta);
check("relatorio nao filtra por corte visivel",
  soDoCorte.contagem.medicoes === 1 && soDoCorte.csv.includes('"1","distancia"'),
  JSON.stringify(soDoCorte.contagem));

// A ordenacao tem de ser estavel e independente da ordem de insercao.
const invertido = buildReport([dist, ang], [notaA, notaB], reportMeta);
check("ordem independe da ordem de insercao", invertido.csv === rel.csv);

// O texto leva o cabecalho do exame e as duas casas do mm, igual a lista.
check("texto comeca pelo cabecalho", rel.texto.startsWith("RELATORIO ODONTOVISION\nPaciente: MARIA, JOAO\n"),
  JSON.stringify(rel.texto.slice(0, 40)));
check("texto traz paciente, exame e data",
  rel.texto.includes("Paciente: MARIA, JOAO") && rel.texto.includes("Exame: CBCT-2024-0142")
    && rel.texto.includes("Data: 2024-03-15"));
check("texto traz o voxel formatado", rel.texto.includes("Voxel: 0.25 x 0.25 x 1.00 mm"),
  rel.texto.split("\n").find((l) => l.startsWith("Voxel:")) ?? "");
check("texto conta medicoes e anotacoes separadas",
  rel.texto.includes("Medicoes: 2") && rel.texto.includes("Anotacoes: 2"));
check("texto com o mm da regua", rel.texto.includes("2.50 mm"), rel.texto);
check("texto com os graus do angulo", rel.texto.includes("53.1\u00B0"), rel.texto);
check("texto traz o delta da regua", rel.texto.includes("\u0394+43 HU"), rel.texto);
// O angulo aparece sem delta: tres pontos nao tem par unico.
check("texto do angulo sem delta", rel.texto.includes("307 -> 103 -> 201 HU"), rel.texto);

// As anotacoes tem secao propria, com o ponto onde o rotulo esta. Sem o
// ponto, o arquivo exportado nao deixa o clinico reencontrar o rotulo.
check("texto tem secao de anotacoes", rel.texto.includes("\nANOTACOES\n"), rel.texto.slice(-200));
check("texto traz o texto da anotacao", rel.texto.includes("Canal mandibular"), rel.texto);
check("texto traz o ponto da anotacao", rel.texto.includes("(5,2)"), rel.texto);
check("texto traz aspas do rotulo sem quebrar a linha",
  rel.texto.includes('Sinfise, "parte" central'), rel.texto);
const secaoNotas = rel.texto.slice(rel.texto.indexOf("ANOTACOES"));
check("as anotacoes vem depois das medicoes",
  rel.texto.indexOf("2.50 mm") < rel.texto.indexOf("ANOTACOES"));
check("tabela de anotacoes tem cabecalho de coluna",
  /#\s+PLANO\s+CORTE\s+PONTE\s+ROTULO/.test(secaoNotas), secaoNotas.split("\n")[1] ?? "");
check("linhas de anotacao nao tem coluna grudada",
  !/Axial\d|Coronal\d/.test(secaoNotas), secaoNotas.split("\n").slice(2).join(" | "));
check("medicoes vem antes das anotacoes",
  rel.texto.indexOf("2.50 mm") < rel.texto.indexOf("ANOTACOES"));

// Relatorio sem medicoes: arquivo bem formado e explicito, em vez de vazio.
const vazio = buildReport([], [], reportMeta);
check("relatorio vazio conta zero",
  vazio.contagem.medicoes === 0 && vazio.contagem.anotacoes === 0);
check("relatorio vazio avisa", vazio.texto.includes("Nenhuma medicao registrada."));
check("CSV vazio e so o cabecalho", vazio.csv.trim().split("\n").length === 1, JSON.stringify(vazio.csv));
// So anotacoes: a secao de medicoes some, a de anotacoes fica. Sem as duas
// secoes vazias, para o relatorio nao fingir que mediu alguma coisa.
const soNotas = buildReport([], [notaA], reportMeta);
check("so anotacoes: avisa que nao mediu",
  soNotas.texto.includes("Nenhuma medicao registrada."), soNotas.texto);
check("so anotacoes: a secao existe", soNotas.texto.includes("ANOTACOES"));
check("so anotacoes: uma linha no CSV", soNotas.csv.trim().split("\n").length === 2);
check("sem metadados, tudo vira '-'", buildReport([], [], null).texto.includes("Paciente: -"),
  buildReport([], [], null).texto.split("\n")[1]);
check("texto e CSV terminam com quebra de linha", rel.texto.endsWith("\n") && rel.csv.endsWith("\n"));
check("nenhuma celula de CSV quebra linha", !rel.csv.split("\n").slice(1).some((l) => l.includes("\r")));

console.log("\n-- sanitizeAnnotationText --");
check("texto normal passa direto", sanitizeAnnotationText("Mandibula"), "Mandibula");
check("espa\u00e7os das pontas somem", sanitizeAnnotationText("  Mandibula  "), "Mandibula");
// O canvas escreve o rotulo numa linha s\u00f3: um \n solto empurraria o resto
// para fora da imagem sem nenhum aviso.
check("quebra de linha vira espaco", sanitizeAnnotationText("Canal\nradicular"), "Canal radicular");
check("espacos internos colapsam", sanitizeAnnotationText("canal   do   nervo"), "canal do nervo");
check("tab vira espaco", sanitizeAnnotationText("a\tb"), "a b");
check("caractere de controle some", sanitizeAnnotationText("a\u0007b"), "a b");
check("so espacos = vazio", sanitizeAnnotationText("   \n  ") === "", JSON.stringify(sanitizeAnnotationText("   \n  ")));
check("vazio = vazio", sanitizeAnnotationText("") === "", "");
// O limite nao e arbitrario: o rotulo e desenhado sobre a imagem.
check("texto curto nao e cortado", sanitizeAnnotationText("x".repeat(MAX_ANNOTATION_CHARS)).length, MAX_ANNOTATION_CHARS);
const longo = sanitizeAnnotationText("y".repeat(200));
check("texto longo e cortado no limite", longo.length, MAX_ANNOTATION_CHARS);
check("texto cortado se declara cortado", longo.endsWith("\u2026"), longo.slice(-4));
// "yyy " + reticencias: se sobrar espaco antes do corte, o rotulo parece ter
// um buraco no fim.
check("nada de espaco antes da reticencia", longo.includes(" \u2026") === false);
check("corte em texto com espacos tambem nao deixa buraco",
  sanitizeAnnotationText("ab ".repeat(40)).includes(" \u2026") === false,
  sanitizeAnnotationText("ab ".repeat(40)).slice(-6));

console.log("\n-- buildAnnotation --");
const anot = buildAnnotation(mprVolume, "axial", 1, 3, 2, "  Nucleo pulposo  ", 1);
check("axial aceita", anot.ok === true);
check("texto limpo no rotulo", anot.ok && anot.annotation.text === "Nucleo pulposo",
  anot.ok ? JSON.stringify(anot.annotation.text) : "recusada");
check("guarda o ponto e o corte", anot.ok
  && anot.annotation.u === 3 && anot.annotation.v === 2 && anot.annotation.slice === 1);
check("guarda o plano", anot.ok && anot.annotation.plane === "axial");
// Texto vazio e recusado, e nao aceito como rotulo invisivel: o usuario
// ficaria sem nenhuma pista de onde a anotacao foi parar.
check("texto vazio e recusado",
  buildAnnotation(mprVolume, "axial", 1, 3, 2, "   ", 1).error === "texto-vazio");
check("texto vazio nao gasta id nem cria", (() => {
  const r = buildAnnotation(mprVolume, "axial", 1, 3, 2, "", 1);
  return r.ok === false && !("annotation" in r);
})());
// As mesmas regras de ponto da regua: dentro da matriz, inteiro, sem negativo.
check("v que so cabe no axial e recusado",
  buildAnnotation(mprVolume, "coronal", 0, 3, 5, "x", 1).error === "fora-do-plano");
check("ponto fracionario e recusado",
  buildAnnotation(mprVolume, "axial", 1, 1.5, 2, "x", 1).error === "fora-do-plano");
check("ponto negativo e recusado",
  buildAnnotation(mprVolume, "axial", 1, -1, 2, "x", 1).error === "fora-do-plano");
// O texto e cortado ANTES de virar anotacao: a lista e o canvas mostram a
// mesma string, nunca uma mais longa que a outra.
check("rotulo longo ja vem cortado no store",
  (() => { const r = buildAnnotation(mprVolume, "axial", 1, 1, 1, "z".repeat(300), 1); return r.ok && r.annotation.text.length === MAX_ANNOTATION_CHARS; })());
// Matriz vazia (0 colunas): o ponto (0,0) esta fora. Uma anotacao "criada" com
// columns=0 nao teria onde ser desenhada.
check("volume vazio recusa o ponto", buildAnnotation(
  { columns: 0, rows: 0, slices: 0, values: new Int16Array(0), rescaleSlope: 1, rescaleIntercept: 0, sliceSpacing: null, pixelSpacing: null },
  "axial", 0, 0, 0, "x", 1).error, "fora-do-plano");

console.log("\n-- phantom do botão de exemplo: metadados, volume e cortes coerentes --");
// Este bloco existe porque o bug apareceu numa CAPTURA DE TELA, não num teste:
// o demo misturava o volume de 64x64x32 com os cortes do mock (180/512/512), o
// slider apontava para cortes inexistentes e todo HU saía NaN. Os 335 checks
// passavam. Um teste de coerência pega a próxima vez.
{
  const { phantomVolume, phantomMetadata, phantomSliceCount } =
    await import("../lib/dicom/phantom.ts");
  const pv = phantomVolume();
  const pm = phantomMetadata();
  const pc = phantomSliceCount();

  check("volume é 64x64x32",
    `${pv.columns}x${pv.rows}x${pv.slices}`, "64x64x32");
  check("metadados batem com o volume",
    pm.matrixDimensions.join("x"), `${pv.columns}x${pv.rows}x${pv.slices}`);
  check("cortes batem com o volume",
    `${pc.Axial}x${pc.Coronal}x${pc.Sagital}`, `${pv.slices}x${pv.rows}x${pv.columns}`);
  // O ponto do bug: um corte do meio do axial tem que existir no volume.
  const meio = Math.floor(pc.Axial / 2);
  check("o corte do meio do axial existe no volume",
    meio >= 0 && meio < pv.slices, `${meio} < ${pv.slices}`);
  check("HU do corte do meio não é NaN", Number.isFinite(planeHuAt(pv, "axial", meio, 32, 32)), true);
  // E o voxelSize do metadado tem que ser o do volume, senão o relatório
  // anuncia uma resolução que a imagem não tem.
  check("voxelSize bate com o volume",
    pm.voxelSize[0] === pv.pixelSpacing?.[0] && pm.voxelSize[2] === pv.sliceSpacing,
    `${pm.voxelSize.join(" x ")} vs ${pv.pixelSpacing?.join(" x ")} x ${pv.sliceSpacing}`);
  check("sliceThickness bate com o sliceSpacing",
    pm.sliceThickness, pv.sliceSpacing);
  // A medição no corte do meio do demo tem que dar número, não NaN: é a
  // exata combinação que a captura mostrou quebrada.
  const demo = buildMeasurement(pv, "axial", meio, { u: 12, v: 40 }, { u: 48, v: 26 }, 1);
  check("régua no corte do meio dá mm finito",
    demo.ok && Number.isFinite(demo.measurement.distanceMm), demo.ok ? String(demo.measurement.distanceMm) : "recusada");
  check("régua no corte do meio dá HU finito",
    demo.ok && Number.isFinite(demo.measurement.huA) && Number.isFinite(demo.measurement.huB),
    demo.ok ? `A=${demo.measurement.huA} B=${demo.measurement.huB}` : "recusada");
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
