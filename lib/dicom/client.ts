// Cliente do Web Worker de parsing. Mantem uma instancia unica e traduz
// o protocolo de mensagens em Promises, correlacionando por request-id.

import type {
  DicomParseResult,
  DicomSeriesResult,
  WorkerRequest,
  WorkerResponse,
} from "./types";

export type { DicomMeta, DicomParseResult, DicomSeriesResult, DicomVolume, Plane } from "./types";
export { huAt, huToGray, autoWindow, sliceToImageData, storedRange } from "./volume";
export { planeHuAt, planeSliceToImageData, planeDimensions, voxelSizeMm } from "./volume";

export class DicomParseError extends Error {
  readonly fileName: string;

  constructor(fileName: string, message: string) {
    super(message);
    this.name = "DicomParseError";
    this.fileName = fileName;
  }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (r: DicomParseResult | DicomSeriesResult) => void; reject: (e: unknown) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./worker.ts", import.meta.url));

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, type, payload } = event.data;
    const handlers = pending.get(id);
    if (!handlers) return;
    pending.delete(id);

    if (type === "result" || type === "series") handlers.resolve(payload);
    else handlers.reject(new DicomParseError(payload.fileName, payload.message));
  };

  worker.onerror = (event) => {
    for (const [, handlers] of pending) {
      handlers.reject(new Error(event.message || "falha no worker de DICOM"));
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

/** Le um unico arquivo .dcm e devolve metadados + volume. */
export function parseDicomFile(file: File): Promise<DicomParseResult> {
  return file.arrayBuffer().then((buffer) => parseDicomBuffer(buffer, file.name));
}

/** Versao com o buffer ja em maos (util para testes). */
export function parseDicomBuffer(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<DicomParseResult> {
  return request("single", [{ byteArray: buffer, fileName }], [buffer]) as Promise<DicomParseResult>;
}

/**
 * Le varios arquivos e monta um volume unico de N cortes.
 *
 * O volume volta com o buffer de valores *transferido*, ou seja, sem copia.
 * O chamador deve tratar o `values` como readonly.
 */
export function parseSeriesFiles(files: File[]): Promise<DicomSeriesResult> {
  return Promise.all(
    files.map(async (file) => ({ byteArray: await file.arrayBuffer(), fileName: file.name })),
  ).then((payload) => request("series", payload, payload.map((p) => p.byteArray)) as Promise<DicomSeriesResult>);
}

/**
 * Versao com os buffers ja em maos. E o que o seletor de arquivos usa quando
 * os arquivos vem de uma pasta ou de uma selecao multipla ja lidos.
 */
export function parseSeriesBuffers(
  buffers: { byteArray: ArrayBuffer; fileName: string }[],
): Promise<DicomSeriesResult> {
  return request("series", buffers, buffers.map((b) => b.byteArray)) as Promise<DicomSeriesResult>;
}

function request(
  kind: WorkerRequest["kind"],
  files: { byteArray: ArrayBuffer; fileName: string }[],
  transfer: Transferable[],
): Promise<DicomParseResult | DicomSeriesResult> {
  const id = ++seq;
  return new Promise<DicomParseResult | DicomSeriesResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // WorkerRequest e um union discriminado por `kind`; aqui os dois formatos
    // valem, entao o objeto so e garantido pelo postMessage em tempo de execucao.
    const message = { id, kind, files } as WorkerRequest;
    // Os buffers vao transferidos, entao a copia da thread principal e
    // descartada em vez de clonada.
    getWorker().postMessage(message, transfer);
  });
}

export function terminateDicomWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}