/**
 * RLE Lossless (PS3.5 Anexo G) e o caminho de pixel data encapsulado.
 *
 * Encapsulado significa que o pixel data vem em fragmentos (itens) dentro de
 * uma sequencia, e nao como bytes soltos -- e o formato de tudo que e
 * comprimido. O app so resolvia o caminho "nativo" e recusava o resto; este
 * modulo e a estrutura para acrescentar outros codecs atras da mesma interface.
 *
 * RLE em si: cada frame tem um cabecalho de 64 bytes (16 uint32 little endian)
 * com a quantidade de segmentos e o offset de cada um. O segmento 1 e o plano
 * MSB dos pixels, o segmento 2 o LSB, e cada um e um fluxo PackBits. O pixel
 * final e `(msb << 8) | lsb`.
 */

import type { DicomVolume } from "./types.ts";

/** Por que o pixel data encapsulado nao virou volume. */
export type RleMotivo =
  | "sem-fragmentos"
  | "frame-vazio"
  | "header-curto"
  | "segmentos-excedidos"
  | "offset-invalido"
  | "bytes-insuficientes";

/**
 * Erro de RLE com o motivo ja separado do texto.
 *
 * Sem parameter property (`constructor(readonly x)`) de proposito: o
 * type-stripping do Node remove tipos e nao sabe o que fazer com isso, e o
 * projeto roda os testes em modo strip-only. E a mesma razao que proibe `enum`
 * e `namespace` em `lib/`.
 */
export class RleError extends Error {
  readonly motivo: RleMotivo;

  constructor(motivo: RleMotivo) {
    super(`RLE: ${motivo}`);
    this.name = "RleError";
    this.motivo = motivo;
  }
}

/** Um fragmento (item) da sequencia encapsulada. */
interface Fragmento {
  offset: number;
  length: number;
}

/**
 * Isola os itens de fragmento dentro de um pixel data encapsulado.
 *
 * Anda pelos item tags em vez de confiar em `fragments`/`basicOffsetTable` do
 * dicom-parser: o `dataOffset` relatado por ele e relativo ao COMECO do
 * elemento, nao ao inicio do arquivo, e um offset errado aqui produz pixels
 * plausiveis e errados -- a mesma classe de bug do big endian. Ler os tags
 * `(FFFE,E000)` na propria fonte da verdade e um codigo que nao tem como
 * divergir.
 *
 * O primeiro item e a Basic Offset Table, que nao e pixel: ela guarda o offset
 * de cada frame, e o app monta o volume por `NumberOfFrames`, entao e
 * descartada.
 */
export function extraiFragmentos(
  byteArray: Uint8Array,
  dataOffset: number,
  length: number,
): Fragmento[] {
  const itens: Fragmento[] = [];
  const fim = dataOffset + length;
  let off = dataOffset;
  // Teto de iteracoes: um arquivo corrompido com length enorme nao pode
  // transformar isto num loop infinito.
  for (let guarda = 0; off + 8 <= fim && guarda < 1_000_000; guarda++) {
    const v = new DataView(byteArray.buffer, byteArray.byteOffset + off, 8);
    const group = v.getUint16(0, true);
    const element = v.getUint16(2, true);
    const tamanho = v.getUint32(4, true);
    off += 8;
    if (group === 0xfffe && element === 0xe000) {
      if (off + tamanho > fim) break;
      itens.push({ offset: off, length: tamanho });
      off += tamanho;
    } else if (group === 0xfffe && element === 0xe0dd) {
      // Sequence Delimitation Item: fim da sequencia.
      break;
    } else {
      // Item inesperado: sem offset confiavel para pular, entao para.
      break;
    }
  }
  // O primeiro item e SEMPRE a Basic Offset Table, por definicao da PS3.5 --
  // ela guarda o offset de cada frame e nao contem pixel. Um frame RLE tem no
  // minimo 64 bytes de cabecalho, entao um item de 4 bytes no lugar de um frame
  // daria "header-curto" em vez de pixels errados: o erro fica visivel.
  return itens.slice(1);
}

/**
 * Descomprime um fluxo PackBits do DICOM, ate `esperado` bytes.
 *
 * **O `0x00` copia UM byte literal, e nao e no-op.** Esse e o detalhe que
 * separa o PackBits do DICOM do original da Apple, e errar aqui produz uma
 * imagem que parece razoavel e esta deslocada a partir do primeiro `0x00`: no
 * `MR_small_RLE.dcm` real, tratar `0x00` como no-op dava 3646 bytes em vez de
 * 4096 -- e os primeiros pixels ainda batiam, entao nada denunciava.
 *
 * A saida e limitada a `esperado`: um segmento pode ter bytes de sobra, e
 * deixar esses bytes vazar para o pixel seguinte baguncaria o resto do volume.
 */
export function descomprimePackBits(entrada: Uint8Array, esperado: number): Uint8Array {
  const saida = new Uint8Array(esperado);
  let o = 0;
  let i = 0;
  while (i < entrada.length && o < esperado) {
    const controle = entrada[i];
    if (controle > 128) {
      // Run: repete o proximo byte (257 - controle) vezes. 129 -> 128, 255 -> 2.
      const repeticoes = 257 - controle;
      const valor = entrada[i + 1];
      i += 2;
      for (let k = 0; k < repeticoes && o < esperado; k++) saida[o++] = valor;
    } else {
      // Literal: 1..127 copiam (controle + 1) bytes; 0 copia exatamente 1.
      const tamanho = controle === 0 ? 1 : controle + 1;
      i += 1;
      for (let k = 0; k < tamanho && o < esperado; k++) saida[o++] = entrada[i + k];
      i += tamanho;
    }
  }
  return saida;
}

/**
 * Descomprime um frame RLE de 16 bits em valores `Int16`/`Uint16`ja com a
 * ordem de bytes resolvida.
 *
 * RLE e sempre little endian (1.2.840.10008.1.2.5), entao o byte LSB vem
 * primeiro: o valor e `(msb << 8) | lsb`.
 */
export function decodificaFrameRle(
  frame: Uint8Array,
  totalPixels: number,
  signed: boolean,
): Int16Array | Uint16Array {
  if (frame.length < 64) throw new RleError("header-curto");
  const v = new DataView(frame.buffer, frame.byteOffset, 64);
  const segmentos = v.getUint32(0, true);
  // 15 offsets + o contador = 16 palavras. Um numero maior nao cabe no
  // cabecalho, e um arquivo corrompido aqui faria o app ler fora do frame.
  if (segmentos < 1 || segmentos > 15) throw new RleError("segmentos-excedidos");

  const esperadoPorSegmento = totalPixels;
  const decomprimidos: Uint8Array[] = [];
  for (let s = 0; s < segmentos; s++) {
    const inicio = v.getUint32((s + 1) * 4, true);
    // O limite de cada segmento e o offset do PROXIMO. Sem isso o fim de um
    // segmento invade o seguinte e a imagem sai deslocada.
    const fim = s + 1 < segmentos ? v.getUint32((s + 2) * 4, true) : frame.length;
    if (inicio >= fim || fim > frame.length) throw new RleError("offset-invalido");
    const comprimido = frame.subarray(inicio, fim);
    const d = descomprimePackBits(comprimido, esperadoPorSegmento);
    if (d.length < esperadoPorSegmento) throw new RleError("bytes-insuficientes");
    decomprimidos.push(d);
  }

  const values = signed ? new Int16Array(totalPixels) : new Uint16Array(totalPixels);
  for (let p = 0; p < totalPixels; p++) {
    const msb = decomprimidos[0][p];
    const lsb = decomprimidos[1]?.[p] ?? 0;
    const bruto = (msb << 8) | lsb;
    // `<< 16 >> 16` converte para signed sem o custo de um branch por pixel.
    if (signed) (values as Int16Array)[p] = bruto << 16 >> 16;
    else (values as Uint16Array)[p] = bruto;
  }
  return values;
}

/**
 * Monta o volume a partir do pixel data encapsulado de um frame so.
 *
 * `frames` e o numero de frames declarado em `NumberOfFrames`. Para
 * multi-frame encapsulado (`NumberOfFrames > 1` com varios fragmentos), o
 * volume ainda nao e montado aqui: um frame so, e `singleFileSliceSpacing`
 * decide se ele vira eixo Z.
 */
export function decodificaRleVolume(
  byteArray: Uint8Array,
  fragmentos: Fragmento[],
  rows: number,
  columns: number,
  frames: number,
  signed: boolean,
  rescaleSlope: number,
  rescaleIntercept: number,
  sliceSpacing: number | null,
  pixelSpacing: number[] | null,
  sourceFileNames?: string[],
): DicomVolume {
  if (fragmentos.length === 0) throw new RleError("sem-fragmentos");
  // Um fragmento por frame; o primeiro item (Basic Offset Table) ja foi
  // descartado por extraiFragmentos.
  if (fragmentos.length < frames) throw new RleError("frame-vazio");

  const pixelsPorFrame = rows * columns;
  const valores = signed
    ? new Int16Array(pixelsPorFrame * frames)
    : new Uint16Array(pixelsPorFrame * frames);
  for (let f = 0; f < frames; f++) {
    const fr = fragmentos[f];
    const frame = byteArray.subarray(fr.offset, fr.offset + fr.length);
    const doFrame = decodificaFrameRle(frame, pixelsPorFrame, signed);
    valores.set(doFrame, f * pixelsPorFrame);
  }

  return {
    values: valores,
    rows,
    columns,
    slices: frames,
    rescaleSlope,
    rescaleIntercept,
    sliceSpacing,
    pixelSpacing,
    sourceFileNames,
  };
}
