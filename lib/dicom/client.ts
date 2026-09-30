// Cliente do Web Worker de parsing. Mantem uma instancia unica e traduz
// o protocolo de mensagens em Promises, correlacionando por request-id.

import type { DicomParseResult, WorkerRequest, WorkerResponse } from "./types";

export type { DicomMeta, DicomParseResult, DicomVolume } from "./types";
export { huAt, huToGray, autoWindow, sliceToImageData, storedRange } from "./volume";

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
  { resolve: (r: DicomParseResult) => void; reject: (e: unknown) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./worker.ts", import.meta.url));

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, type, payload } = event.data;
    const handlers = pending.get(id);
    if (!handlers) return;
    pending.delete(id);

    if (type === "result") handlers.resolve(payload);
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
  const id = ++seq;
  return new Promise<DicomParseResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: WorkerRequest = { id, byteArray: buffer, fileName };
    // O buffer vai transferido, entao a copia da thread principal e
    // descartada em vez de clonada.
    getWorker().postMessage(request, [buffer]);
  });
}

export function terminateDicomWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
