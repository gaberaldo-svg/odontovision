// Escrita de DICOM Part 10 (Explicit VR Little Endian) para os geradores de
// fixture. Compartilhado entre make-sample-dcm.mjs e make-sample-series.mjs
// para que ambos emitam exatamente a mesma estrutura de arquivo.

const enc = new TextEncoder();

const LONG_VRS = new Set(["OB", "OW", "OF", "OD", "OL", "SQ", "UT", "UN", "UC", "UR"]);

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** US (unsigned short) little endian. */
export function us(value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
}

/** DS com varios valores, separados por barra invertida como manda o padrao. */
export function ds(...values) {
  return values.join("\\");
}

/** Elemento DICOM explicit VR little endian. */
export function el(group, element, vr, value) {
  const isLong = LONG_VRS.has(vr);
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

/** 128 bytes de padding + "DICM". */
export function preamble() {
  const p = new Uint8Array(132);
  p.set(enc.encode("DICM"), 128);
  return p;
}

/**
 * File Meta Information do grupo 0002, com o group length obrigatorio.
 * O group length e calculado sobre o resto do grupo, por isso os elementos
 * sao montados primeiro.
 */
export function fileMeta({ sopClassUid, sopInstanceUid, transferSyntaxUid, implClassUid, implVersion }) {
  const body = concat([
    el(0x0002, 0x0002, "UI", sopClassUid), // MediaStorageSOPClassUID
    el(0x0002, 0x0003, "UI", sopInstanceUid), // MediaStorageSOPInstanceUID
    el(0x0002, 0x0010, "UI", transferSyntaxUid), // TransferSyntaxUID
    el(0x0002, 0x0012, "UI", implClassUid), // ImplementationClassUID
    el(0x0002, 0x0013, "UI", implVersion), // ImplementationVersionName
  ]);
  return concat([el(0x0002, 0x0000, "UL", uint32Le(body.length)), body]);
}

function uint32Le(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}

/** Monta o arquivo completo: preamble + file meta + dataset. */
export function buildFile(meta, datasetParts) {
  const dataset = concat(datasetParts);
  const fm = fileMeta(meta);
  return concat([preamble(), fm, dataset]);
}
