"use client";

// Fase 2: leitura de UM arquivo .dcm por vez. Escolhe o primeiro .dcm
// solto e reporta o resultado no console do navegador.

import { useCallback, useRef, useState } from "react";
import { FileScan, Loader2, TriangleAlert } from "lucide-react";
import { parseDicomFile, type DicomParseResult } from "@/lib/dicom/client";

type Status = "idle" | "reading" | "done" | "error";

export function FileLoader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const onPick = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setStatus("reading");
    setMessage(null);

    try {
      const result: DicomParseResult = await parseDicomFile(file);

      // Especificado na fase 2: metadados no console.
      console.group(`[OdontoVision] ${result.fileName}`);
      console.table(result.meta);
      console.log("pixelData:", result.pixelData);
      console.log("tags lidas:", result.tagCount, "| avisos:", result.warnings.length);
      console.groupEnd();

      setStatus("done");
      setMessage(
        `${result.meta.rows}x${result.meta.columns} · ${result.meta.numberOfFrames} frame(s) · ` +
          `${result.tagCount} tags · ${result.meta.pixelSpacing?.join(" x ") ?? "-"} mm`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error("[OdontoVision] falha ao ler o arquivo:", error);
      setStatus("error");
      setMessage(text);
    }
  }, []);

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept=".dcm,.dicom,application/dicom"
        onChange={onPick}
        className="sr-only"
        aria-label="Selecionar arquivo DICOM"
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={status === "reading"}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {status === "reading" ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <FileScan className="size-3.5" aria-hidden />
        )}
        {status === "reading" ? "Lendo..." : "Ler arquivo .dcm"}
      </button>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        O arquivo e processado localmente. Use <code className="font-mono">samples/phantom-64.dcm</code>{" "}
        gerado por <code className="font-mono">npm run sample</code>.
      </p>

      {message && (
        <p
          role="status"
          className={`flex items-start gap-1.5 rounded border px-2 py-1.5 font-mono text-[10px] leading-relaxed ${
            status === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border bg-accent/40 text-muted-foreground"
          }`}
        >
          {status === "error" && <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />}
          <span className="break-words">{message}</span>
        </p>
      )}
    </div>
  );
}
