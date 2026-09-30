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
// A sintaxe de transferencia e 1.2.840.10008.1.2.1 (Explicit VR LE). O UID
// 1.2.840.10008.5.1.4.1.1.2 e o SOP Class de CT Image Storage e NAO pode
// aparecer aqui: o gerador antigo colocava esse valor no lugar errado.
check("TransferSyntaxUID", dataSet.string("x00020010"), "1.2.840.10008.1.2.1");
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
check("ImagePositionPatient", dataSet.string("x00200032"), "-8.0\\-8.0\\-45.0");
// ImageOrientationPatient tem 6 valores (3 da linha + 3 da coluna).
check("ImageOrientationPatient", dataSet.string("x00200037"), "1\\0\\0\\0\\1\\0");

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

// --- gêmeo big endian ---
// Este caso nasceu de um arquivo real (MR_small_bigendian.dcm, do pydicom):
// o Explicit VR Big Endian é a ÚNICA sintaxe de transferência cujo pixel data
// não é little endian, e ler os bytes ao contrário devolve um volume sem
// nenhum erro — o HU sai plausível e errado, que é o pior tipo de bug porque
// a tela parece estar certa.
//
// O teste não depende do arquivo real: ele Fabrica o gêmeo big endian da
// própria fixture, trocando a sintaxe e invertendo cada pixel. Se a inversão
// voltar, os valores deste teste voltam a bater e o bug some.
console.log("\n-- gêmeo big endian da própria fixture --");
const { parseDicom } = await import("../lib/dicom/parse.ts");
const { huAt: huAtLib } = await import("../lib/dicom/volume.ts");
const { descomprimePackBits, decodificaFrameRle, RleError } =
  await import("../lib/dicom/rle.ts");
const { valoresDoImageData, ehJpegDoNavegador, precisaoDoJpeg } = await import("../lib/dicom/jpeg.ts");
const LE_UID = "1.2.840.10008.1.2.1";
const BE_UID = "1.2.840.10008.1.2.2";
if (LE_UID.length !== BE_UID.length) {
  // Sem isso a troca de UID mudaria o tamanho do arquivo e o elemento de pixel
  // data ficaria deslocado -- o teste estaria medindo outra coisa.
  console.log("  FAIL  UIDs de tamanhos diferentes: a troca no lugar nao cabe");
  fail++;
} else {
  const be = new Uint8Array(byteArray); // copia
  const uidLe = new TextEncoder().encode(LE_UID);
  const uidBe = new TextEncoder().encode(BE_UID);
  let trocouUid = false;
  for (let i = 0; i + uidLe.length <= be.length; i++) {
    let igual = true;
    for (let k = 0; k < uidLe.length; k++) if (be[i + k] !== uidLe[k]) { igual = false; break; }
    if (!igual) continue;
    be.set(uidBe, i);
    trocouUid = true;
    break;
  }
  check("sintaxe trocada no lugar", trocouUid, true);

  // Inverte cada par de bytes do pixel data.
  const beEl = dicomParser.parseDicom(be).elements.x7fe00010;
  for (let o = beEl.dataOffset; o + 1 < beEl.dataOffset + beEl.length; o += 2) {
    const tmp = be[o];
    be[o] = be[o + 1];
    be[o + 1] = tmp;
  }

  const rLe = parseDicom(new Uint8Array(byteArray), "phantom-64.dcm");
  const rBe = parseDicom(be, "phantom-64-be.dcm");

  check("gêmeo big endian também vira volume", !!rBe.volume, true);
  check("gêmeo big endian não precisa descomprimir", rBe.needsDecompression, false);
  check("mesma matriz",
    `${rBe.volume?.columns}x${rBe.volume?.rows}`,
    `${rLe.volume?.columns}x${rLe.volume?.rows}`);
  // A comparação que importa: os DOIS volumes têm de ser idênticos. Um teste
  // de "o valor não é NaN" passaria com os bytes trocados — e é por isso que
  // este check compara os números, e não a sanidade deles.
  check("primeiros valores idênticos",
    Array.from(rBe.volume?.values.slice(0, 4) ?? []).join(" "),
    Array.from(rLe.volume?.values.slice(0, 4) ?? []).join(" "));
  check("volume inteiro idêntico, voxel a voxel",
    rBe.volume?.values.every((v, i) => v === rLe.volume?.values[i]), true);

  // E o HU, pela mesma conta que a tela usa.
  check("HU idêntico no centro",
    huAtLib(rBe.volume, 32, 32, 0), huAtLib(rLe.volume, 32, 32, 0), 0.001);
}

// --- gêmeo RLE da própria fixture ---
// RLE Lossless (PS3.5 Anexo G) é o primeiro codec que o app decodifica. Este
// caso nasceu de um arquivo real (MR_small_RLE.dcm, do pydicom), que é o
// gêmeo comprimido de MR_small.dcm: comparar os dois voxel a voxel é o que
// prova o decoder.
//
// O teste não baixa nada: ele **fabrica** o gêmeo RLE da própria fixture, com
// um encoder PackBits escrito aqui. Isso cobre o decoder em qualquer máquina,
// offline — e o encoder usa runs de repetição de propósito, porque um encoder
// só de literais deixaria o caminho principal do decoder (a run) sem teste.
console.log("\n-- gêmeo RLE da própria fixture --");

/**
 * PackBits do DICOM, o inverso do decoder. Os dois casos que importam:
 *  - `0x00` grava UM literal (é assim que o DICOM se diferencia do Apple);
 *  - 0xFF é uma run de 2 (o menor repeatcount), então 130..255 viram runs.
 */
function empacotaPackBits(dados) {
  const saida = [];
  let i = 0;
  while (i < dados.length) {
    // Conta a run de repetição, mas uma run de 2 bytes não paga o custo
    // (2 bytes de controle+valor contra 2 literais = 3 bytes), então o
    // mínimo é 3.
    let run = 1;
    while (i + run < dados.length && dados[i + run] === dados[i] && run < 128) run++;
    if (run >= 3) {
      saida.push(257 - run, dados[i]);
      i += run;
    } else {
      // Coleta literais até achar uma run de 3 ou mais.
      let j = i;
      let tamanho = 0;
      while (j < dados.length && tamanho < 128) {
        const r =
          j + 2 < dados.length && dados[j] === dados[j + 1] && dados[j] === dados[j + 2] ? 3 : 1;
        if (r === 3) break;
        j += r;
        tamanho += r;
      }
      if (tamanho === 0) { j = i + 1; tamanho = 1; }
      saida.push(tamanho - 1);
      for (let k = 0; k < tamanho; k++) saida.push(dados[i + k]);
      i += tamanho;
    }
  }
  return saida;
}

/** Monta um frame RLE de 16 bits a partir dos valores, em dois segmentos. */
function frameRle(valores, signed) {
  const msb = new Uint8Array(valores.length);
  const lsb = new Uint8Array(valores.length);
  for (let i = 0; i < valores.length; i++) {
    const v = signed ? ((valores[i] << 16) >> 16) : valores[i] & 0xffff;
    msb[i] = (v >> 8) & 0xff;
    lsb[i] = v & 0xff;
  }
  const segMsb = empacotaPackBits(msb);
  const segLsb = empacotaPackBits(lsb);
  const cabecalho = new Uint8Array(64);
  const hv = new DataView(cabecalho.buffer);
  hv.setUint32(0, 2, true);            // 2 segmentos
  hv.setUint32(4, 64, true);           // segmento 1 (MSB) começa no fim do header
  hv.setUint32(8, 64 + segMsb.length, true); // segmento 2 (LSB)
  const frame = new Uint8Array(64 + segMsb.length + segLsb.length);
  frame.set(cabecalho, 0);
  frame.set(segMsb, 64);
  frame.set(segLsb, 64 + segMsb.length);
  return frame;
}

// Reconstroi o .dcm: troca a sintaxe por RLE, troca o pixel data nativo por
// uma sequencia encapsulada (item vazio = Basic Offset Table, item do frame,
// e o Sequence Delimitation Item no fim).
const RLE_UID = "1.2.840.10008.1.2.5";
if (LE_UID.length !== RLE_UID.length) {
  console.log("  FAIL  UIDs de tamanhos diferentes: a troca no lugar nao cabe");
  fail++;
} else {
  const rLe = parseDicom(new Uint8Array(byteArray), "phantom-64.dcm");
  const v = rLe.volume;
  const frame = frameRle(v.values, true);
  const rleBytes = new Uint8Array(byteArray); // copia

  const uidLe = new TextEncoder().encode(LE_UID);
  const uidRle = new TextEncoder().encode(RLE_UID);
  let trocouUid = false;
  for (let i = 0; i + uidLe.length <= rleBytes.length; i++) {
    let igual = true;
    for (let k = 0; k < uidLe.length; k++) if (rleBytes[i + k] !== uidLe[k]) { igual = false; break; }
    if (!igual) continue;
    rleBytes.set(uidRle, i);
    trocouUid = true;
    break;
  }
  check("sintaxe trocada por RLE", trocouUid, true);

  // Constroi a sequencia e substitui o pixel data in-place. O tamanho muda,
  // entao o arquivo inteiro e remontado a partir do elemento original.
  const leEl = dicomParser.parseDicom(rleBytes).elements.x7fe00010;
  const antes = rleBytes.subarray(0, leEl.dataOffset);
  const depois = rleBytes.subarray(leEl.dataOffset + leEl.length);

  const item = (payload) => {
    const b = new Uint8Array(8 + payload.length);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, 0xfffe, true); dv.setUint16(2, 0xe000, true);
    dv.setUint32(4, payload.length, true);
    b.set(payload, 8);
    return b;
  };
  const delimitador = new Uint8Array(8);
  const dvDel = new DataView(delimitador.buffer);
  dvDel.setUint16(0, 0xfffe, true); dvDel.setUint16(2, 0xe0dd, true);

  const sequencia = new Uint8Array(item(new Uint8Array(0)).length + item(frame).length + delimitador.length);
  const i0 = item(new Uint8Array(0)), i1 = item(frame);
  sequencia.set(i0, 0);
  sequencia.set(i1, i0.length);
  sequencia.set(delimitador, i0.length + i1.length);

  // O pixel data e o ultimo elemento do arquivo, entao `antes` termina no
  // cabecalho de 12 bytes (tag+VR+reservado+length) e `depois` tem quase nada.
  // O length ocupa os 4 ultimos bytes de `antes` e vira indefinido
  // (0xFFFFFFFF) -- e assim que pixel data encapsulado se anuncia. A sequencia
  // entra colada, em `antes.length`.
  const rleDcm = new Uint8Array(antes.length + sequencia.length + depois.length);
  rleDcm.set(antes, 0);
  const hdr = new DataView(rleDcm.buffer);
  hdr.setUint32(antes.length - 4, 0xffffffff, true);
  rleDcm.set(sequencia, antes.length);
  rleDcm.set(depois, antes.length + sequencia.length);

  const rRle = parseDicom(rleDcm, "phantom-64-rle.dcm");
  check("RLE não pede descompressão", rRle.needsDecompression, false);
  check("RLE vira volume", !!rRle.volume, true);
  check("mesma matriz", rRle.volume
    ? `${rRle.volume.columns}x${rRle.volume.rows}x${rRle.volume.slices}`
    : "-", `${v.columns}x${v.rows}x${v.slices}`);
  // A comparação que importa: os valores tem de ser IDÊNTICOS aos da fixture
  // crua. Um check de "não é NaN" passaria com bytes trocados.
  check("primeiros valores idênticos ao arquivo cru",
    rRle.volume ? Array.from(rRle.volume.values.slice(0, 4)).join(" ") : "-",
    Array.from(v.values.slice(0, 4)).join(" "));
  check("volume inteiro idêntico, voxel a voxel",
    rRle.volume !== null && rRle.volume.values.length === v.values.length
      && rRle.volume.values.every((x, i) => x === v.values[i]), true);
  check("mesmo HU no centro", rRle.volume
    ? huAtLib(rRle.volume, 32, 32, 0) : NaN, huAtLib(v, 32, 32, 0), 0.001);
  check("mesmo HU no ar (o minimo, onde o RLE mais comprime)",
    rRle.volume ? huAtLib(rRle.volume, 2, 2, 0) : NaN, huAtLib(v, 2, 2, 0), 0.001);
  check("mesmo sliceSpacing", rRle.volume?.sliceSpacing, v.sliceSpacing);
}

// O `0x00` do PackBits do DICOM copia UM literal. Se o decoder tratar como
// no-op (a convenção do Apple), a imagem sai deslocada do primeiro `0x00` em
// diante — e os primeiros pixels ainda batem, então nenhum sintoma aparece.
// --- RLE multi-frame ---
// `decodificaRleVolume` promete aceitar N frames, e isso nunca foi testado com
// N > 1. Um frame so nao pega o erro mais provavel: usar o MESMO fragmento para
// todos os cortes, o que daria um volume com N copias da primeira imagem -- sem
// nenhum sintoma, so a segunda anatomia errada.
console.log("\n-- RLE multi-frame: cada corte vem do seu fragmento --");
{
  const rLe1 = parseDicom(new Uint8Array(byteArray), "phantom-64.dcm");
  const base = Array.from(rLe1.volume.values);
  // Frame 2 = frame 1 com +7 em cada voxel: assim os dois cortes sao
  // distinguiveis, e um bug de "reusar o fragmento" aparece como copia
  // identica em vez de um offset uniforme.
  const frame2 = base.map((v) => v + 7);

  // Monta a sequencia com DOIS itens de frame, mais o BOT vazio.
  const item = (payload) => {
    const b = new Uint8Array(8 + payload.length);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, 0xfffe, true); dv.setUint16(2, 0xe000, true);
    dv.setUint32(4, payload.length, true);
    b.set(payload, 8);
    return b;
  };
  const del = new Uint8Array(8);
  const dvDel = new DataView(del.buffer);
  dvDel.setUint16(0, 0xfffe, true); dvDel.setUint16(2, 0xe0dd, true);

  const i0 = item(new Uint8Array(0));
  const i1 = item(frameRle(Int16Array.from(base), true));
  const i2 = item(frameRle(Int16Array.from(frame2), true));
  const seq = new Uint8Array(i0.length + i1.length + i2.length + del.length);
  seq.set(i0, 0); seq.set(i1, i0.length);
  seq.set(i2, i0.length + i1.length);
  seq.set(del, i0.length + i1.length + i2.length);

  const leEl = dicomParser.parseDicom(new Uint8Array(byteArray)).elements.x7fe00010;
  const antes = new Uint8Array(byteArray).subarray(0, leEl.dataOffset);
  const depois = new Uint8Array(byteArray).subarray(leEl.dataOffset + leEl.length);
  const multi = new Uint8Array(antes.length + seq.length + depois.length);
  multi.set(antes, 0);
  new DataView(multi.buffer).setUint32(antes.length - 4, 0xffffffff, true);
  multi.set(seq, antes.length);
  multi.set(depois, antes.length + seq.length);

  // NumberOfFrames = "1" -> "2": mesmo comprimento, entao troca no lugar.
  const rUid = new TextEncoder().encode(LE_UID);
  const rRle = new TextEncoder().encode(RLE_UID);
  for (let i = 0; i + rUid.length <= multi.length; i++) {
    let ok = true;
    for (let k = 0; k < rUid.length; k++) if (multi[i + k] !== rUid[k]) { ok = false; break; }
    if (!ok) continue;
    multi.set(rRle, i);
    break;
  }
  const frames = new TextEncoder().encode("1");
  for (let i = 0; i + frames.length <= multi.length; i++) {
    if (multi[i] !== 0x31) continue;
    // So o NumberOfFrames importa: nao mexer em nenhum outro "1" solto.
    const tag = i - 8;
    if (tag < 0) continue;
    const tv = new DataView(multi.buffer, multi.byteOffset + tag, 4);
    if (tv.getUint16(0, true) === 0x0028 && tv.getUint16(2, true) === 0x0008) {
      multi[i] = 0x32; // "2"
      break;
    }
  }

  const rMulti = parseDicom(multi, "phantom-64-rle-2frames.dcm");
  check("multi-frame vira volume", !!rMulti.volume, true);
  check("slices = 2", rMulti.volume?.slices, 2);
  check("total de voxels = 2 cortes", rMulti.volume?.values.length, base.length * 2);
  check("corte 1 identico ao original",
    rMulti.volume ? Array.from(rMulti.volume.values.slice(0, 4)).join(" ") : "-",
    base.slice(0, 4).join(" "));
  // O teste que pega o bug de "reusar o fragmento": os dois cortes tem de ser
  // DIFERENTES, e o segundo exatamente o primeiro + 7.
  check("corte 2 NAO e copia do corte 1",
    rMulti.volume ? rMulti.volume.values[base.length] !== rMulti.volume.values[0] : false, true);
  check("corte 2 identico ao esperado (+7)",
    rMulti.volume ? rMulti.volume.values[base.length] : NaN, base[0] + 7, 0.001);
  check("corte 2 inteiro correto",
    rMulti.volume
      ? rMulti.volume.values.every((v, i) => i < base.length || v === base[i - base.length] + 7)
      : false, true);
  check("corte 1 continua correto depois do 2",
    rMulti.volume
      ? rMulti.volume.values.slice(0, base.length).every((v, i) => v === base[i])
      : false, true);
}

console.log("\n-- extração de valores de um ImageData (o JPEG em si é do navegador) --");
// O decoder JPEG NÃO é nosso: é o do navegador. O que é nosso, e o que este
// teste cobre, é a extração: o RGBA que ele devolve -> valores do volume, com o
// PixelPaddingValue e a ordem de bytes. Um check de "não é NaN" passaria com
// os canais errados, então o teste compara os números.
const rgba = (cinzas) => {
  const d = new Uint8ClampedArray(cinzas.length * 4);
  cinzas.forEach((g, i) => { d[i * 4] = g; d[i * 4 + 1] = g; d[i * 4 + 2] = g; d[i * 4 + 3] = 255; });
  return d;
};
const vUnsigned = valoresDoImageData(rgba([0, 60, 120, 255]), 4, 0, false);
check("cinza vem do canal R", Array.from(vUnsigned).join(" "), "0 60 120 255");
check("Uint16Array quando nao e signed", vUnsigned.constructor.name, "Uint16Array");

// PixelPaddingValue: JPEG entrega 8 bits sem sinal num container de 16. Sem o
// padding o volume inteiro sai deslocado -- e o sintoma e "o HU esta todo
// errado por um numero fixo", que parece calibracao, nao bug.
const comPadding = valoresDoImageData(rgba([0, 128, 255]), 3, 2000, false);
check("PixelPaddingValue soma ao valor", Array.from(comPadding).join(" "), "2000 2128 2255");

// Signed: um Byte de 8 bits cabe folgado em Int16, entao osigned so aparece
// quando o PixelPaddingValue empurra o total para fora da faixa positiva.
const vSigned = valoresDoImageData(rgba([200, 100, 255]), 3, 0, true);
check("Int16Array quando signed", vSigned.constructor.name, "Int16Array");
check("byte de 8 bits cabe em Int16 sem virar negativo",
  Array.from(vSigned).join(" "), "200 100 255");
// 200 + 32800 = 33000, que estoura o Int16 e tem de dar negativo em vez de
// embrulhar para um numero positivo e plausivel.
const vOverflow = valoresDoImageData(rgba([200]), 1, 32800, true);
check("signed estoura para negativo em vez de embrulhar",
  Array.from(vOverflow).join(" "), String((200 + 32800 << 16 >> 16)));

// Um ImageData menor (o navegador pode recortar) nao pode deixar buraco nem
// estourar o volume.
check("ImageData curto para no tamanho do volume",
  Array.from(valoresDoImageData(rgba([1, 2, 3, 4, 5]), 3, 0, false)).join(" "), "1 2 3");
check("ImageData grande e truncado no esperado",
  Array.from(valoresDoImageData(rgba([1, 2, 3, 4, 5]), 4, 0, false)).join(" "), "1 2 3 4");
check("ImageData vazio nao quebra", valoresDoImageData(new Uint8ClampedArray(0), 4, 0, false).length, 4);

// Só Baseline e Extended são do navegador. Lossless e 2000 não são, e mandá-los
// para o createImageBitmap daria uma imagem em silêncio errada.
check("Baseline é do navegador", ehJpegDoNavegador("1.2.840.10008.1.2.4.50"), true);
check("Extended é do navegador", ehJpegDoNavegador("1.2.840.10008.1.2.4.51"), true);
check("JPEG Lossless NÃO é do navegador", ehJpegDoNavegador("1.2.840.10008.1.2.4.57"), false);
check("JPEG 2000 NÃO é do navegador", ehJpegDoNavegador("1.2.840.10008.1.2.4.90"), false);
check("JPEG-LS NÃO é do navegador", ehJpegDoNavegador("1.2.840.10008.1.2.4.80"), false);
check("RLE NÃO é JPEG", ehJpegDoNavegador("1.2.840.10008.1.2.5"), false);
check("transfer syntax ausente não é JPEG", ehJpegDoNavegador(null), false);

// Precisão do SOF: o navegador só vai até 8 bits, e JPEG Extended de 12/16 é
// comum em imagem médica. Sem ler o SOF, o createImageBitmap recusa com uma
// mensagem que não diz nada sobre o motivo.
const sof = (precisao) => {
  // SOI + SOF0 + EOI. No SOF o comprimento ocupa [4..5] e a PRECISÃO é [6].
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10,
    0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  b[6] = precisao;
  return b;
};
check("SOF de 8 bits é lido", precisaoDoJpeg(sof(8)), 8);
check("SOF de 12 bits é lido", precisaoDoJpeg(sof(12)), 12);
check("SOF de 16 bits é lido", precisaoDoJpeg(sof(16)), 16);
// SOF1 = Extended, que é o caso do JPEG-lossy.dcm real do pydicom.
check("SOF1 (Extended) de 12 bits é lido",
  precisaoDoJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xc1, 0x00, 0x11, 0x0c, 0x00, 0x10,
    0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])), 12);
// Um JPEG normal tem DQT antes do SOF; o leitor tem que pular marcador em vez de
// ler a precisão do lugar errado.
check("pula DQT antes do SOF",
  precisaoDoJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9])), 8);
check("sem SOF devolve null (não inventa)", precisaoDoJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
check("stream vazio não trava", precisaoDoJpeg(new Uint8Array(0)), null);
check("não lê DHT como se fosse SOF",
  precisaoDoJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9])), null);

console.log("\n-- PackBits do DICOM: 0x00 copia um literal --");
check("0x00 seguido de byte = 1 byte de saída",
  Array.from(descomprimePackBits(new Uint8Array([0x00, 0x07]), 1)).join(" "), "7");
// `0x00` como no-op (convenção Apple) leria `0x00, 42, 0, 99` como 42, 99
// pulando um byte e errando em silêncio. Como literal de 1, dá 42, 99.
check("0x00 copia UM literal, não é no-op",
  Array.from(descomprimePackBits(new Uint8Array([0, 42, 0, 99]), 2)).join(" "), "42 99");
check("literal de 3 bytes (controle 2)", 
  Array.from(descomprimePackBits(new Uint8Array([2, 10, 20, 30]), 3)).join(" "), "10 20 30");
check("run de 3 (controle 254)", 
  Array.from(descomprimePackBits(new Uint8Array([254, 8, 9]), 3)).join(" "), "8 8 8");
check("run de 128 (controle 129)", 
  Array.from(descomprimePackBits(new Uint8Array([129, 5]), 128)).every((b) => b === 5), true);
check("run de 2 (controle 255)", 
  Array.from(descomprimePackBits(new Uint8Array([255, 6]), 2)).join(" "), "6 6");
check("mistura de run e literal na ordem",
  Array.from(descomprimePackBits(new Uint8Array([254, 1, 1, 99, 77]), 5)).join(" "), "1 1 1 99 77");
// A saída é limitada: bytes de sobra de um segmento não podem vazar para o
// pixel seguinte, ou o resto do volume sai deslocado.
check("saída limitada ao tamanho esperado",
  Array.from(descomprimePackBits(new Uint8Array([254, 1, 1, 1, 1]), 2)).join(" "), "1 1");
check("entrada curta não passa do esperado",
  Array.from(descomprimePackBits(new Uint8Array([2, 1, 2]), 2)).join(" "), "1 2");

console.log("\n-- header RLE inválido é recusado com nome --");
// Um frame que não é RLE tem de dar erro nomeado, não pixels aleatórios.
for (const [nome, entrada, motivo] of [
  ["curto demais", new Uint8Array(10), "header-curto"],
  ["segmentos = 0", (() => { const b = new Uint8Array(64); return b; })(), "segmentos-excedidos"],
  ["segmentos = 16", (() => { const b = new Uint8Array(64); new DataView(b.buffer).setUint32(0, 16, true); return b; })(), "segmentos-excedidos"],
]) {
  try {
    decodificaFrameRle(entrada, 100, true);
    check(`recusa: ${nome} (${motivo})`, false, true);
  } catch (e) {
    check(`recusa: ${nome} (${motivo})`,
      e instanceof RleError && e.motivo === motivo, true);
  }
}

console.log("\n-- arquivo que a biblioteca não sabe ler --");
// dicom-parser lança `TypeError: i.copy is not a function` para sintaxes que
// ele não conhece (Deflate). O nome minificado não pode chegar na tela: o
// usuário precisa saber que o problema é o arquivo, não o programa.
const lixo = new Uint8Array(256);
try {
  parseDicom(quaseDicom(lixo), "quebrado.dcm");
  console.log("  FAIL  deveria ter lançado");
  fail++;
} catch (e) {
  const msg = String(e.message ?? e);
  check("lança com o nome do arquivo", msg.includes("quebrado.dcm"), true);
  // O detalhe original vem no fim, entre parenteses: uteis para quem vai
  // reportar o problema, desde que a mensagem nao comece por ele.
  check("mensagem sem nome minificado de biblioteca",
    !/i\.copy|is not a function|undefined/.test(msg), true);
  check("diz que pode ser compressao", /compress|corrompido/i.test(msg), true);
  check("detalhe original preservado no fim", /Detalhe da biblioteca: \S/.test(msg), true);
}

/** 132 bytes de preamble+"DICM" e um arquivo que nao tem elemento nenhum. */
function quaseDicom(bytes) {
  bytes.set(new TextEncoder().encode("DICM"), 128);
  return bytes;
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
