/**
 * JPEG Baseline/Extended pela via do navegador.
 *
 * O navegador ja tem um decoder JPEG completo e lossless em relacao a um
 * decoder proprio. Escrever um aqui seriam ~400 linhas para chegar ao mesmo
 * lugar, entao o trabalho de verdade e o EMOLDURAMENTO: achar o fragmento,
 * extrair o valor de cada pixel e remontar o volume no layout `[z][y][x]`.
 *
 * **O numero de HU de uma imagem JPEG e aproximado, e a UI avisa.** O arquivo
 * ja perdeu informacao na compressao com perda: comparar o HU guardado aqui com
 * o de um software que decodificou o mesmo arquivo de outro jeito da diferenca
 * de alguns unidades. Isso vale para qualquer decoder, nosso ou nao -- a
 * diferenca e que o nosso delega a perda ao navegador em vez de esconde-la.
 *
 * O que este modulo NAO faz: JPEG Lossless, JPEG 2000 e JPEG-LS. Lossless nao
 * e JPEG de verdade para o navegador (16 bits, sem huffman de processo 1), e
 * 2000 e wavelet.
 */

import { extraiFragmentos } from "./rle.ts";
import type { DicomVolume } from "./types.ts";

/** Transfer syntaxes que o `createImageBitmap` do navegador entende. */
const JPEG_BROWSER = new Set([
  "1.2.840.10008.1.2.4.50", // JPEG Baseline (processo 1)
  "1.2.840.10008.1.2.4.51", // JPEG Extended (processo 1, ate 16 bits)
]);

export function ehJpegDoNavegador(transferSyntax: string | null): boolean {
  return transferSyntax !== null && JPEG_BROWSER.has(transferSyntax);
}

/** O minimo de metadados que a decodificacao precisa. */
export interface JpegMeta {
  rows: number;
  columns: number;
  numberOfFrames: number;
  pixelRepresentation: "signed" | "unsigned";
  /**
   * PixelPaddingValue (0028,0120). JPEG entrega 8 bits sem sinal; quando o
   * BitsAllocated e 16, o valor guardado e `pixel + padding` para caber no
   * container. Sem isso o volume inteiro sai deslocado pelo padding.
   */
  pixelPaddingValue: number;
}

/**
 * Extrai os valores de um `ImageData` em tons de cinza.
 *
 * Um JPEG em tons de cinza chega do navegador como **RGBA**, entao o valor esta
 * nos tres canais. Usa-se o R: em JPEG lossless (YCC) o navegador pode
 * devolver canais diferentes, e nesse caso o R ainda e o que o `grayscale()` do
 * canvas produziria.
 *
 * `esperado` e o total de pixels do corte. Um `ImageData` menor (o navegador
 * pode recortar) deixaria buracos no volume, entao o excedente e ignorado em
 * vez de virar `undefined`.
 */
export function valoresDoImageData(
  data: Uint8ClampedArray,
  esperado: number,
  pixelPaddingValue: number,
  signed: boolean,
): Int16Array | Uint16Array {
  const values = signed ? new Int16Array(esperado) : new Uint16Array(esperado);
  const n = Math.min(esperado, Math.floor(data.length / 4));
  for (let p = 0; p < n; p++) {
    // `<< 16 >> 16` volta o byte para signed 16 bits sem branch por pixel.
    const v = (data[p * 4] + pixelPaddingValue) << 16 >> 16;
    if (signed) (values as Int16Array)[p] = v;
    else (values as Uint16Array)[p] = v;
  }
  return values;
}

/**
 * Precisao, em bits, do JPEG de um fragmento.
 *
 * Sai do SOF: o byte 4 do segmento, logo apos o marcador e o comprimento.
 * Navegador so decodifica **8 bits**, e JPEG Extended existe precisamente para
 * 12 e 16 — que e o caso do `JPEG-lossy.dcm` real do pydicom (SOF1 com P=12).
 * Sem esta leitura o `createImageBitmap` simplesmente recusa e o usuario ve
 * "a imagem nao pode ser decodificada", que nao diz nada sobre o motivo.
 *
 * Marcadores SOF: C0-CF, menos C4 (DHT), C8 (JPG) e CC (DAC).
 */
export function precisaoDoJpeg(frame: Uint8Array): number | null {
  let i = 2; // pula o SOI
  while (i + 10 < frame.length) {
    if (frame[i] !== 0xff) { i++; continue; }
    const marcador = frame[i + 1];
    if (marcador === 0xd8 || (marcador >= 0xd0 && marcador <= 0xd7)) { i += 2; continue; }
    if (marcador === 0xd9 || marcador === 0xda) return null;
    const comprimento = (frame[i + 2] << 8) | frame[i + 3];
    const eSof =
      marcador >= 0xc0 && marcador <= 0xcf &&
      marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc;
    if (eSof) return frame[i + 4];
    if (comprimento < 2) return null; // stream corrompido: sair, nao girar
    i += 2 + comprimento;
  }
  return null;
}

/**
 * Decodifica os frames JPEG de um arquivo e monta o volume.
 *
 * Assinatura async porque `createImageBitmap` e assincrono. E por isso que isto
 * roda no **worker** e nao na main thread -- alem de o `createImageBitmap` e
 * `OffscreenCanvas` existirem em `DedicatedWorkerGlobalScope`, a main thread
 * nem teria os bytes: o `postMessage` TRANSFERE o ArrayBuffer para o worker,
 * entao a copia da thread principal fica detached.
 *
 * `pixelData` sao os dois numeros que o `parseDicom` ja calculou. Reimplementar
 * aqui a varredura de elementos do arquivo seria refazer o dicom-parser.
 */
export async function decodificaJpegVolume(
  byteArray: Uint8Array,
  pixelData: { dataOffset: number; length: number },
  meta: JpegMeta,
  rescaleSlope: number,
  rescaleIntercept: number,
  sliceSpacing: number | null,
  pixelSpacing: number[] | null,
  sourceFileNames?: string[],
): Promise<DicomVolume> {
  const fragmentos = extraiFragmentos(byteArray, pixelData.dataOffset, pixelData.length);
  if (fragmentos.length < meta.numberOfFrames) {
    throw new Error(
      `JPEG: ${meta.numberOfFrames} frames declarados, ${fragmentos.length} fragmentos`,
    );
  }

  const pixelsPorFrame = meta.rows * meta.columns;
  const signed = meta.pixelRepresentation === "signed";
  const valores = signed
    ? new Int16Array(pixelsPorFrame * meta.numberOfFrames)
    : new Uint16Array(pixelsPorFrame * meta.numberOfFrames);

  for (let f = 0; f < meta.numberOfFrames; f++) {
    const fr = fragmentos[f];
    const fragmento = byteArray.subarray(fr.offset, fr.offset + fr.length);

    // O navegador so decodifica JPEG de 8 bits. JPEG Extended de 12/16 existe e
    // e comum em imagem medica, e recusar aqui com o motivo e infinitamente
    // mais util do que deixar o createImageBitmap dizer "nao pode decodificar".
    const precisao = precisaoDoJpeg(fragmento);
    if (precisao !== null && precisao > 8) {
      throw new Error(
        `JPEG de ${precisao} bits: o navegador decodifica ate 8 bits, e este ` +
          `arquivo e JPEG Extended. Use um visualizador com decoder proprio, ou ` +
          `exporte o exame em RLE Lossless.`,
      );
    }

    // Um fragmento DICOM de JPEG e um arquivo JPEG: comeca em SOI (FFD8) e
    // termina em EOI (FFD9). O navegador aceita esse stream direto.
    //
    // O cast e atrito de tipagem do TS 5.7, nao de copia: `subarray` devolve
    // `Uint8Array<ArrayBufferLike>` e o `BlobPart` quer `ArrayBuffer`. Envolver
    // em `new Uint8Array(...)` resolveria e copiaria o frame inteiro de cada
    // corte, que num volume de 300 fatias sao dezenas de MB de copia por nada.
    const blob = new Blob([fragmento as unknown as BlobPart], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("JPEG: OffscreenCanvas sem contexto 2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = ctx.getImageData(0, 0, width, height);
    valores.set(
      valoresDoImageData(img.data, pixelsPorFrame, meta.pixelPaddingValue, signed),
      f * pixelsPorFrame,
    );
  }

  return {
    values: valores,
    rows: meta.rows,
    columns: meta.columns,
    slices: meta.numberOfFrames,
    rescaleSlope,
    rescaleIntercept,
    sliceSpacing,
    pixelSpacing,
    sourceFileNames,
  };
}
