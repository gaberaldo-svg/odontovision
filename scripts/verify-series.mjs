// Testa a montagem de serie contra a fixture de 32 cortes, usando o mesmo
// codigo de producao (lib/dicom/parse.ts -> lib/dicom/series.ts).
//
//   node --experimental-strip-types scripts/verify-series.mjs
//
// A fixture vem de scripts/make-sample-series.mjs, que exporta a funcao
// huAtVoxel. Comparamos voxel a voxel, entao qualquer erro de permutacao de
// eixo, de ordenacao ou de recorte aparece imediatamente.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERIES_DIR = join(ROOT, "samples", "series");
const MULTIFRAME = join(ROOT, "samples", "series-multiframe.dcm");

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label.padEnd(44)} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label.padEnd(44)} ${detail}`);
  }
}

function near(label, actual, expected, tol) {
  check(label, Math.abs(actual - expected) <= tol, `= ${actual} (esperado ${expected} +/- ${tol})`);
}

if (!existsSync(SERIES_DIR)) {
  console.error(`fixture ausente: ${SERIES_DIR}\nRode: npm run sample:series`);
  process.exit(1);
}

const { parseSeries, parseDicom } = await import("../lib/dicom/parse.ts");
const { sortSlices, sliceNormal, SeriesError } = await import("../lib/dicom/series.ts");
const { huAt, planeHuAt, planeSliceToImageData, voxelSizeMm } = await import("../lib/dicom/volume.ts");
const { huAtVoxel, denseRadiusAt } = await import("./make-sample-series.mjs");

const readFile = (path) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const fileNames = readdirSync(SERIES_DIR).filter((f) => f.endsWith(".dcm")).sort();

console.log(`\nfixture: ${fileNames.length} cortes em samples/series\n`);

check("gerou 32 cortes", fileNames.length === 32, `${fileNames.length}`);

// Ordena os nomes de proposito fora de ordem: a montagem precisa se basear no
// InstanceNumber, nao na ordem em que o navegador entregou os arquivos.
const embaralhado = [...fileNames].sort((a, b) => {
  const na = Number(a.match(/(\d+)/)?.[1] ?? 0);
  const nb = Number(b.match(/(\d+)/)?.[1] ?? 0);
  return (na * 7919) % 13 - (nb * 7919) % 13;
});
const reversed = [...fileNames].reverse();

for (const [rotulo, lista] of [
  ["ordem embaralhada", embaralhado],
  ["ordem invertida", reversed],
]) {
  const resultado = parseSeries(
    lista.map((n) => ({ byteArray: readFile(join(SERIES_DIR, n)), fileName: n })),
  );

  console.log(`\n-- montagem com ${rotulo} --`);
  check(`${rotulo}: ordenado por InstanceNumber`, resultado.orderedBy === "instanceNumber", resultado.orderedBy);
  check(`${rotulo}: primeiro corte e o InstanceNumber 1`,
    resultado.fileNames[0] === "slice-000.dcm", resultado.fileNames[0]);
  check(`${rotulo}: ultimo corte e o InstanceNumber 32`,
    resultado.fileNames[31] === "slice-031.dcm", resultado.fileNames[31]);
  check(`${rotulo}: volume 64x64x32`,
    resultado.volume.columns === 64 && resultado.volume.rows === 64 && resultado.volume.slices === 32,
    `${resultado.volume.columns}x${resultado.volume.rows}x${resultado.volume.slices}`);
  near(`${rotulo}: z spacing = 1mm (das posicoes)`, resultado.sliceSpacing ?? 0, 1, 1e-6);
  check(`${rotulo}: pixel spacing 0.25`,
    resultado.volume.pixelSpacing?.[0] === 0.25 && resultado.volume.pixelSpacing?.[1] === 0.25,
    JSON.stringify(resultado.volume.pixelSpacing));
  check(`${rotulo}: nenhum corte descartado`, resultado.skipped.length === 0,
    JSON.stringify(resultado.skipped));
  check(`${rotulo}: signed`, resultado.meta.pixelRepresentation === "signed");

  if (rotulo === "ordem invertida") {
    // Confere o conteudo voxel a voxel contra o gerador.
    let divergencias = 0;
    let primeiroErro = "";
    for (let z = 0; z < 32; z += 3) {
      for (let y = 0; y < 64; y += 7) {
        for (let x = 0; x < 64; x += 7) {
          const esperado = huAtVoxel(x, y, z);
          const obtido = huAt(resultado.volume, x, y, z);
          if (Math.abs(obtido - esperado) > 0) {
            divergencias++;
            if (!primeiroErro) primeiroErro = `(${x},${y},${z}) esperado ${esperado}, veio ${obtido}`;
          }
        }
      }
    }
    check(`${rotulo}: voxels batem com o gerador`, divergencias === 0,
      divergencias === 0 ? "todas as amostras iguais" : `${divergencias} divergencias; ${primeiroErro}`);

    // O eixo Z tem de crescer: prova que os cortes entraram na ordem certa.
    const raioEmZ0 = huAtVoxel(32, 31, 0);
    const raioEmZ31 = huAtVoxel(32, 31, 31);
    const hounsfieldZ0 = huAt(resultado.volume, 32, 31, 0);
    const hounsfieldZ31 = huAt(resultado.volume, 32, 31, 31);
    check("Z=0 le o corte inicial", hounsfieldZ0 === raioEmZ0, `${hounsfieldZ0}`);
    check("Z=31 le o corte final", hounsfieldZ31 === raioEmZ31, `${hounsfieldZ31}`);

    // Um ponto cuja camada depende de z: prova que a montagem nao misturou.
    const emZ0 = huAt(resultado.volume, 41, 31, 0);
    const emZ15 = huAt(resultado.volume, 41, 31, 15);
    check("mesmo (x,y) muda de camada com z", emZ0 !== emZ15,
      `z=0 -> ${emZ0} (soft), z=15 -> ${emZ15} (casca)`);
    check("z=0 em (41,31) e tecido mole", Math.abs(emZ0 - 120) <= 2, `= ${emZ0}`);
    check("z=15 em (41,31) e casca", Math.abs(emZ15 - 900) <= 2, `= ${emZ15}`);

    console.log("\n-- MPR sobre a serie real --");
    const blob = (plane, index, u, v) => planeHuAt(resultado.volume, plane, index, u, v);
    // A massa deslocada esta em (47.5, 19.5) e so entre z=8 e z=23.
    check("coronal y=19 passa pela massa", Math.abs(blob("coronal", 19, 47, 15) - 2200) <= 2,
      `= ${blob("coronal", 19, 47, 15)}`);
    check("sagital x=47 passa pela massa", Math.abs(blob("sagital", 47, 19, 15) - 2200) <= 2,
      `= ${blob("sagital", 47, 19, 15)}`);
    check("coronal y=31 nao ve a massa", Math.abs(blob("coronal", 31, 47, 15) - 120) <= 2,
      `= ${blob("coronal", 31, 47, 15)}`);
    check("massa some acima de z=23", Math.abs(blob("sagital", 47, 19, 30) - 120) <= 2,
      `= ${blob("sagital", 47, 19, 30)}`);
    check("massa presente em z=9", Math.abs(blob("sagital", 47, 19, 9) - 2200) <= 2,
      `= ${blob("sagital", 47, 19, 9)}`);

    // Renderizacao dos planos: a massa deslocada ocupa x 43.5..51.5 e y 15.5..23.5,
// e o nucleo central nao alcanca x=47 nem y=19. Nos dois planos, a coluna do
// centro da massa tem de ser bem mais clara que uma coluna longe dela.
//
// Nao usamos argmax: as colunas dentro da massa empatam dentro do ruido +/-2
// HU, entao o "primeiro a ganhar" seria ruido, nao geometria.
    const brilhoColuna = (img, u) => {
      let soma = 0;
      for (let v = 0; v < img.height; v++) soma += img.data[(v * img.width + u) * 4];
      return soma;
    };
    // sagital com indice 47 fixa x=47, entao u percorre y
    const sagImg = planeSliceToImageData(resultado.volume, "sagital", 47, 4000, 500, 1);
    const massaSag = brilhoColuna(sagImg, 19);
    const vazioSag = brilhoColuna(sagImg, 5);
    check("sagital x=47: coluna y=19 (massa) muito mais clara que y=5",
      massaSag > vazioSag * 1.5, `massa ${massaSag} vs vazio ${vazioSag}`);
    check("sagital x=47: coluna da massa e a mais clara da faixa 16..23",
      [16, 17, 18, 19, 20, 21, 22, 23].every((u) => brilhoColuna(sagImg, u) > vazioSag * 1.5),
      "toda a faixa da massa acende");
    // coronal com indice 19 fixa y=19, entao u percorre x
    const corImg = planeSliceToImageData(resultado.volume, "coronal", 19, 4000, 500, 1);
    const massaCor = brilhoColuna(corImg, 47);
    const vazioCor = brilhoColuna(corImg, 5);
    check("coronal y=19: coluna x=47 (massa) muito mais clara que x=5",
      massaCor > vazioCor * 1.5, `massa ${massaCor} vs vazio ${vazioCor}`);

    // Um plano que nao passa pela massa tem de ser bem mais escuro.
    const semMassaImg = planeSliceToImageData(resultado.volume, "sagital", 10, 4000, 500, 1);
    const total = (img) => {
      let soma = 0;
      for (let i = 0; i < img.data.length; i += 4) soma += img.data[i];
      return soma;
    };
    check("sagital x=10 (sem massa) e mais escuro que x=47",
      total(semMassaImg) < total(sagImg), `${total(semMassaImg)} vs ${total(sagImg)}`);
    check("coronal e sagittal nao renderizam a mesma imagem",
      total(corImg) !== total(sagImg), `${total(corImg)} vs ${total(sagImg)}`);

    const mm = voxelSizeMm(resultado.volume);
    check("voxel em mm: 0.25 x 0.25 x 1", mm.x === 0.25 && mm.y === 0.25 && mm.z === 1,
      JSON.stringify(mm));
    check("aspecto Z = 4 px por corte",
      (resultado.volume.sliceSpacing ?? 0) / resultado.volume.pixelSpacing[1] === 4,
      "z 1mm / pixel 0.25mm");
  }
}

console.log("\n-- fallback: ordenacao por posicao --");
{
  // Instancias sem InstanceNumber, mas com ImagePositionPatient em Z crescente.
  const semNumero = [2, 0, 3, 1].map((i) => {
    const nome = `slice-${String(i).padStart(3, "0")}.dcm`;
    const caminho = join(SERIES_DIR, nome);
    const b = readFileSync(caminho);
    const r = parseDicom(new Uint8Array(readFileSync(caminho)), nome);
    r.meta.instanceNumber = null;
    return { fileName: nome, meta: r.meta, values: r.volume.values };
  });
  const { sorted, orderedBy } = sortSlices(semNumero);
  check("sem InstanceNumber ordena por posicao", orderedBy === "imagePosition", orderedBy);
  check("ordem por posicao = 000,001,002,003",
    sorted.map((s) => s.fileName).join(",") ===
      "slice-000.dcm,slice-001.dcm,slice-002.dcm,slice-003.dcm",
    sorted.map((s) => s.fileName).join(","));
}

console.log("\n-- fallback: ordenacao por nome --");
{
  const semNada = ["c.dcm", "a.dcm", "b10.dcm", "b2.dcm"].map((n) => ({
    fileName: n,
    meta: { instanceNumber: null, imagePosition: null, imageOrientation: null },
    values: new Int16Array(0),
  }));
  const { sorted, orderedBy } = sortSlices(semNada);
  check("sem InstanceNumber e sem posicao ordena por nome", orderedBy === "fileName", orderedBy);
  check("ordem numerica natural (b2 antes de b10)",
    sorted.map((s) => s.fileName).join(",") === "a.dcm,b2.dcm,b10.dcm,c.dcm",
    sorted.map((s) => s.fileName).join(","));
}

console.log("\n-- normal do plano (row_dir x col_dir) --");
check("IOP identidade -> normal Z", sliceNormal([1, 0, 0, 0, 1, 0]).every((v, i) => Math.abs(v - [0, 0, 1][i]) < 1e-9),
  JSON.stringify(sliceNormal([1, 0, 0, 0, 1, 0])));
// Uma serie sagital valida pode ter normal -X. O sinal so muda a direcao da
// ordenacao em Z, que funciona igual para os dois sentidos.
check("IOP sagital -> normal -X (sinal aceito)", sliceNormal([0, 1, 0, 0, 0, -1]).every((v, i) => Math.abs(v - [-1, 0, 0][i]) < 1e-9),
  JSON.stringify(sliceNormal([0, 1, 0, 0, 0, -1])));
check("normal e unitario", Math.abs(
  Math.hypot(...sliceNormal([1, 0, 0, 0, 1, 0]))) === 1);
check("IOP ausente -> normal Z padrao",
  sliceNormal(null).every((v, i) => Math.abs(v - [0, 0, 1][i]) < 1e-9));

console.log("\n-- serie invalida e rejeitada com mensagem --");
{
  const base = parseDicom(new Uint8Array(readFileSync(join(SERIES_DIR, "slice-000.dcm"))), "a.dcm");
  const outro = parseDicom(new Uint8Array(readFileSync(join(SERIES_DIR, "slice-001.dcm"))), "b.dcm");

  const matrizDiferente = { fileName: "b.dcm", meta: { ...outro.meta, rows: 32 }, values: outro.volume.values };
  let msg = "";
  try {
    const { assembleSeries } = await import("../lib/dicom/series.ts");
    assembleSeries([
      { fileName: "a.dcm", meta: base.meta, values: base.volume.values },
      matrizDiferente,
    ]);
  } catch (e) {
    msg = e instanceof SeriesError ? e.message : `naoSeriesError: ${e.message}`;
  }
  check("matriz divergente lanca SeriesError", msg.includes("Matriz divergente"), msg);

  const escalaDiferente = { fileName: "b.dcm", meta: { ...outro.meta, rescaleIntercept: -1024 }, values: outro.volume.values };
  msg = "";
  try {
    const { assembleSeries } = await import("../lib/dicom/series.ts");
    assembleSeries([
      { fileName: "a.dcm", meta: base.meta, values: base.volume.values },
      escalaDiferente,
    ]);
  } catch (e) {
    msg = e instanceof SeriesError ? e.message : `naoSeriesError: ${e.message}`;
  }
  check("escala HU divergente lanca SeriesError", msg.includes("Escala HU divergente"), msg);
}

console.log("\n-- arquivo multi-frame gera volume de N cortes --");
if (existsSync(MULTIFRAME)) {
  const r = parseDicom(new Uint8Array(readFileSync(MULTIFRAME)), "series-multiframe.dcm");
  check("NumberOfFrames = 32", r.meta.numberOfFrames === 32, `${r.meta.numberOfFrames}`);
  check("volume tem 32 cortes", r.volume?.slices === 32, `${r.volume?.slices}`);
  check("z = 1mm via SpacingBetweenSlices", r.volume?.sliceSpacing === 1, `${r.volume?.sliceSpacing}`);
  let divergencias = 0;
  for (let z = 0; z < 32; z += 5) {
    for (let y = 0; y < 64; y += 9) {
      for (let x = 0; x < 64; x += 9) {
        if (Math.abs(huAt(r.volume, x, y, z) - huAtVoxel(x, y, z)) > 0) divergencias++;
      }
    }
  }
  check("multi-frame bate com o gerador", divergencias === 0, `${divergencias} divergencias`);
  near("raio do nucleo cresce com z (z=31)", denseRadiusAt(31), 12, 1e-9);
} else {
  check("fixture multi-frame existe", false, "rode npm run sample:series");
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
