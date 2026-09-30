// Cliente do Web Worker de parsing. Mantem uma instancia unica e traduz
// o protocolo de mensagens em Promises.

export interface DicomMeta {
  transferSyntax: string | null;
  sopClass: string | null;
  patientName: string | null;
  patientId: string | null;
  studyDate: string | null;
  seriesDescription: string | null;
  manufacturer: string | null;
  modality: string | null;
  rows: number;
  columns: number;
  samplesPerPixel: number;
  numberOfFrames: number;
  pixelSpacing: number[] | null;
  sliceThickness: number | null;
  spacingBetweenSlices: number | null;
  imagePosition: number[] | null;
  imageOrientation: number[] | null;
  rescaleSlope: number;
  rescaleIntercept: number;
  rescaleType: string | null;
  bitsAllocated: number;
  bitsStored: number;
  pixelRepresentation: "signed" | "unsigned";
  windowCenter: number | null;
  windowWidth: number | null;
}

export interface DicomParseResult {
  ok: true;
  fileName: string;
  meta: DicomMeta;
  pixelData: {
    offset: number | null;
    length: number | null;
    isEncapsulated: boolean;
    frameBytes: number;
  };
  tagCount: number;
  warnings: string[];
}

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
const pending = new Map<number, { resolve: (r: DicomParseResult) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./worker.ts", import.meta.url));

  worker.onmessage = (event: MessageEvent) => {
    const { id, type, payload } = event.data as
      | { id: number; type: "result"; payload: DicomParseResult }
      | { id: number; type: "error"; payload: { fileName: string; message: string } };

    const handlers = pending.get(id);
    if (!handlers) return;
    pending.delete(id);

    if (type === "result") handlers.resolve(payload);
    else handlers.reject(new DicomParseError(payload.fileName, payload.message));
  };

  worker.onerror = (event) => {
    for (const [, handlers] of pending) handlers.reject(new Error(event.message));
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

/** Le um unico arquivo .dcm e devolve os metadados. */
export function parseDicomFile(file: File): Promise<DicomParseResult> {
  return file.arrayBuffer().then((buffer) => parseDicomBuffer(buffer, file.name));
}

/** Versao com o buffer ja em maos (util para testes). */
export function parseDicomBuffer(buffer: ArrayBuffer, fileName: string): Promise<DicomParseResult> {
  const id = ++seq;
  return new Promise<DicomParseResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, byteArray: buffer, fileName }, [buffer]);
  });
}

export function terminateDicomWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
