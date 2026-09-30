// Casca de Web Worker: traduce mensagens em chamadas a parse.ts.
// A logica fica em parse.ts para poder ser testada no Node sem DOM.

import type { DicomVolume, WorkerRequest, WorkerResponse } from "./types";
import { parseDicom, parseSeries } from "./parse.ts";
import { singleFileSliceSpacing } from "./series.ts";
import { decodificaJpegVolume, ehJpegDoNavegador } from "./jpeg.ts";

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

// `onmessage` pode ser async: o `createImageBitmap` do JPEG e assincrono, e o
// `postMessage` de resposta acontece DEPOIS do await. O `id` garante que a
// resposta chegue ao pedido certo mesmo com varios em voo.
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
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
    const bytes = new Uint8Array(file.byteArray);
    const payload = parseDicom(bytes, file.fileName);
    // JPEG e o unico codec que o navegador decodifica. `createImageBitmap` e
    // `OffscreenCanvas` existem em `DedicatedWorkerGlobalScope`, e e aqui que os
    // bytes estao: o ArrayBuffer foi transferido para o worker, entao a copia
    // da thread principal esta detached. `parseDicom` segue sincrono; so este
    // passo e assincrono.
    if (payload.needsDecompression && payload.volume === null && payload.pixelData
        && ehJpegDoNavegador(payload.meta.transferSyntax)) {
      const m = payload.meta;
      payload.volume = await decodificaJpegVolume(
        bytes,
        payload.pixelData,
        {
          rows: m.rows,
          columns: m.columns,
          numberOfFrames: m.numberOfFrames,
          pixelRepresentation: m.pixelRepresentation,
          pixelPaddingValue: m.pixelPaddingValue,
        },
        m.rescaleSlope,
        m.rescaleIntercept,
        singleFileSliceSpacing(m, m.numberOfFrames),
        m.pixelSpacing,
        [file.fileName],
      );
      // Deixa de ser "precisa descomprimir": a UI olha essa flag ANTES do
      // volume, e sem esta linha ela mostraria "sem decoder" para um arquivo
      // que acabou de ser decodificado.
      payload.needsDecompression = false;
    }
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
