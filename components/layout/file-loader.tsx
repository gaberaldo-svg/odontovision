"use client";

// Le um .dcm solto ou uma serie inteira. Com varios arquivos, os cortes sao
// ordenados e montados num volume unico (lib/dicom/series.ts), o que destrava
// coronal e sagital.

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileScan, FolderOpen, Loader2, TriangleAlert } from "lucide-react";
import { parseDicomFile, parseSeriesFiles, type DicomParseResult, type DicomSeriesResult } from "@/lib/dicom/client";
import { onOpenFilePicker } from "@/lib/dicom/file-picker";
import { useViewerStore } from "@/store/use-viewer-store";

type Status = "idle" | "reading" | "done" | "error";

const ACCEPT = ".dcm,.dicom,application/dicom";

const DICOM_EXT = /\.(dcm|dicom)$/i;

/** Nomes de arquivo -> ordem numerica natural (b2 antes de b10). */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function FileLoader({ compact = false }: { compact?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const loadVolume = useViewerStore((state) => state.loadVolume);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  // Botoes em outras partes da UI pedem a abertura deste mesmo input.
  useEffect(() => onOpenFilePicker(() => fileRef.current?.click()), []);

  const loadFiles = useCallback(
    async (files: File[]) => {
      const dicom = files.filter((f) => DICOM_EXT.test(f.name)).sort((a, b) => byName(a.name, b.name));

      if (dicom.length === 0) {
        setStatus("error");
        setMessage("Nenhum arquivo .dcm na selecao.");
        return;
      }

      setStatus("reading");
      setMessage(null);

      try {
        // Um arquivo so mantem o caminho antigo: mensagem de arquivo unico.
        if (dicom.length === 1) {
          const result: DicomParseResult = await parseDicomFile(dicom[0]);
          const { meta, volume } = result;

          console.group(`[OdontoVision] ${result.fileName}`);
          console.table(meta);
          console.log("volume:", volume);
          console.log("tags lidas:", result.tagCount, "| avisos:", result.warnings.length);
          console.groupEnd();

          if (result.needsDecompression) {
            setStatus("error");
            setMessage(
              "Sintaxe de transferencia comprimida. Decodificacao JPEG/JPEG2000 fica para uma fase posterior.",
            );
            return;
          }
          if (!volume) {
            setStatus("error");
            setMessage("O arquivo nao trouxe pixel data utilizavel (16 bits, escala de cinza).");
            return;
          }

          loadVolume(meta, volume, null);
          setStatus("done");
          setMessage(
            `${meta.columns}x${meta.rows} · ${volume.slices} corte(s) · ` +
              `${result.tagCount} tags · ${meta.pixelSpacing?.slice(0, 2).join(" x ") ?? "-"} mm`,
          );
          return;
        }

        // Varios arquivos: monta a serie.
        const result: DicomSeriesResult = await parseSeriesFiles(dicom);
        const { meta, volume } = result;

        console.group(`[OdontoVision] serie de ${result.fileNames.length} cortes`);
        console.table(meta);
        console.log("ordenado por:", result.orderedBy);
        console.log("z spacing:", result.sliceSpacing, "mm");
        console.log("volume:", volume);
        if (result.skipped.length > 0) console.table(result.skipped);
        console.groupEnd();

        if (volume.slices === 0) {
          setStatus("error");
          setMessage(
            result.skipped.length > 0
              ? `Nenhum dos ${dicom.length} arquivos virou volume: ${result.skipped[0].reason}.`
              : "Nenhum dos arquivos trouxe pixel data utilizavel.",
          );
          return;
        }

        loadVolume(meta, volume, {
          orderedBy: result.orderedBy,
          fileCount: dicom.length,
          skipped: result.skipped,
        });

        const skippedNote =
          result.skipped.length > 0 ? ` · ${result.skipped.length} ignorado(s)` : "";
        setStatus("done");
        setMessage(
          `${volume.columns}x${volume.rows}x${volume.slices} · ${result.fileNames.length} cortes` +
            `${skippedNote} · ordenado por ${result.orderedBy} · z ${
              result.sliceSpacing?.toFixed(2) ?? "-"
            } mm`,
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.error("[OdontoVision] falha ao ler a serie:", error);
        setStatus("error");
        setMessage(text);
      }
    },
    [loadVolume],
  );

  const onPickFiles = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void loadFiles(files);
    },
    [loadFiles],
  );

  // webkitdirectory entrega os .dcm da pasta com o caminho relativo no webkitRelativePath,
  // mas o File.name ja traz o basename — que e o que ordenamos.
  const onPickDirectory = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void loadFiles(files);
    },
    [loadFiles],
  );

  const busy = status === "reading";

  const buttonClass =
    "inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50";

  return (
    <div className="space-y-2">
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={onPickFiles}
        className="sr-only"
        aria-label="Selecionar arquivos DICOM"
      />
      <input
        ref={dirRef}
        type="file"
        multiple
        onChange={onPickDirectory}
        className="sr-only"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        aria-label="Selecionar pasta com DICOM"
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className={buttonClass}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <FileScan className="size-3.5" aria-hidden />
          )}
          {busy ? "Lendo..." : ".dcm"}
        </button>
        <button
          type="button"
          onClick={() => dirRef.current?.click()}
          disabled={busy}
          className={`${buttonClass} bg-secondary text-secondary-foreground`}
        >
          <FolderOpen className="size-3.5" aria-hidden />
          Pasta
        </button>
      </div>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {compact ? (
          "Processado localmente no navegador."
        ) : (
          <>
            Selecione varios <code className="font-mono">.dcm</code> de uma vez (ou a pasta
            inteira) para montar a serie e liberar coronal e sagital. Processado localmente. Use{" "}
            <code className="font-mono">samples/series/</code> gerado por{" "}
            <code className="font-mono">npm run sample:series</code>.
          </>
        )}
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