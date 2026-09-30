// Casca de Web Worker: traduce mensagens em chamadas a parse.ts.
// A logica fica em parse.ts para poder ser testada no Node sem DOM.

import type { DicomVolume, WorkerRequest, WorkerResponse } from "./types";
import { parseDicom, parseSeries } from "./parse.ts";

/** Buffers que podem ser transferidos de volta sem custo de copia. */
function transferables(volume: DicomVolume | null): Transferable[] {
  return volume ? [volume.values.buffer as Transferable] : [];
}

/** dicom-parser lanca um objeto puro { exception, dataSet }, nao uma Error. */
function errorText(error: unknown): string {
  const e = error as { exception?: string; message?: string } | undefined;
  return e?.exception ?? e?.message ?? String(error);
}

// Dentro de um worker, `self` e o DedicatedWorkerGlobalScope. Sem o
// webworker lib o TS resolve `self` como Window, entao estreitamos o tipo.
const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, kind, files } = event.data;
  const firstName = files[0]?.fileName ?? "";

  try {
    if (kind === "series") {
      const payload = parseSeries(files);
      const response: WorkerResponse = { id, type: "series", payload };
      post(response, transferables(payload.volume));
      return;
    }

    const file = files[0];
    const payload = parseDicom(new Uint8Array(file.byteArray), file.fileName);
    const response: WorkerResponse = { id, type: "result", payload };
    post(response, transferables(payload.volume));
  } catch (error) {
    const response: WorkerResponse = {
      id,
      type: "error",
      payload: { fileName: firstName, message: errorText(error) },
    };
    post(response);
  }
};
