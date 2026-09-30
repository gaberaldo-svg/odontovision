"use client";

import * as React from "react";
import { useViewerStore } from "@/store/use-viewer-store";
import { Copy, Download, FileScan, Lock, Tag, X } from "lucide-react";
import type { MeasureError } from "@/lib/dicom/measure";
import { buildReport } from "@/lib/dicom/report";
import { MAX_ANNOTATION_CHARS } from "@/lib/dicom/annotate";
import { formatDeg, formatDeltaHu, formatMm, PLANO_LABEL } from "@/lib/format";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { FileLoader } from "@/components/layout/file-loader";

const ERRO_MEDIDA: Record<MeasureError, string> = {
  "fora-do-plano": "Clique dentro da imagem para medir.",
  "ponto-igual": "Os dois pontos precisam ser diferentes.",
  "vertice-igual": "O vertice do angulo precisa ficar fora das duas pontas.",
};

export function Sidebar() {
  const {
    isSidebarOpen,
    metadata,
    windowWidth,
    windowCenter,
    cursorHU,
    measurements,
    removeMeasurement,
    clearMeasurements,
    lastMeasureError,
    annotations,
    annotationText,
    setAnnotationText,
    removeAnnotation,
    clearAnnotations,
    activeTool,
  } = useViewerStore();

  const [copiado, setCopiado] = React.useState(false);

  const report = React.useMemo(
    () => buildReport(measurements, metadata),
    [measurements, metadata],
  );

  /** Ponto 3D do crosshair,ja em (u,v) de cada plano. Ver addAnnotationAtCrosshair. */
  const slices = useViewerStore((state) => state.slices);
  const addAnnotation = useViewerStore((state) => state.addAnnotation);

  /**
   * Enter no campo de anotacao amarra o rotulo ao crosshair de cada plano.
   *
   * Os tres viewports compartilham um unico crosshair (e o MPR que garante
   * isso), entao existe um unico ponto 3D. Traduzir para o plano de cada
   * viewport e o mesmo `voxelFromPlane` que o clique usa, entao o rotulo
   * criado pelo Enter e o criado pelo clique caem no mesmo lugar.
   */
  function addAnnotationAtCrosshair() {
    if (annotationText.trim().length === 0) return;
    for (const [viewport, plane] of [
      ["Axial", "axial"], ["Coronal", "coronal"], ["Sagital", "sagittal"],
    ] as const) {
      const slice = slices[viewport];
      // Um mesmo ponto 3D vira (u,v) diferente em cada plano; e o mapeamento
      // do MPR, nao um chute.
      const paraUV =
        plane === "axial" ? { u: slices.Sagital, v: slices.Coronal }
        : plane === "coronal" ? { u: slices.Sagital, v: slices.Axial }
        : { u: slices.Coronal, v: slices.Axial };
      addAnnotation(plane, slice, paraUV.u, paraUV.v);
    }
  }

  // Nome do arquivo pelo paciente e a data do exame: e o que o clinico procura
  // na pasta de downloads depois. Sem separador "/", que vira pasta no Windows.
  const nomeCsv =
    `medicoes-${(metadata?.patientId ?? "exame").replace(/[^\w.-]+/g, "_")}-` +
    `${(metadata?.studyDate ?? "sem-data").replace(/[^\w.-]+/g, "_")}.csv`;

  function baixarCsv() {
    const url = URL.createObjectURL(
      new Blob([report.csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = nomeCsv;
    a.click();
    // Sem revogar, o Blob fica vivo na aba ate recarregar: em medico abrindo
    // e baixando relatorio em sequencia isso vira vazamento de memoria.
    URL.revokeObjectURL(url);
  }

  async function copiarRelatorio() {
    try {
      await navigator.clipboard.writeText(report.texto);
      setCopiado(true);
    } catch {
      // Sem permissao de clipboard (http sem TLS, ou navegador negando): o
      // relatorio continua visivel no <pre> e o CSV continua baixavel, entao
      // avisar "copiado" seria mentir sobre o que aconteceu.
      setCopiado(false);
    }
  }

  if (!isSidebarOpen) return null;

  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="p-3 border-b border-sidebar-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Exame</h2>
        <div className="mt-2">
          <FileLoader compact />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 flex flex-col gap-6">
        {!metadata ? (
          <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
            <FileScan className="size-8 text-muted-foreground" />
            <p className="text-xs">Nenhum exame</p>
            <p className="text-[10px] text-muted-foreground">
              Carregue um exame para ver os metadados
            </p>
          </div>
        ) : (
          <>
            <dl className="flex flex-col">
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Paciente</dt>
                <dd className="font-mono text-[11px] truncate">{metadata.patientName}</dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">ID do exame</dt>
                <dd className="font-mono text-[11px] truncate">{metadata.patientId}</dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Data</dt>
                <dd className="font-mono text-[11px] truncate">{metadata.studyDate}</dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Série</dt>
                <dd className="font-mono text-[11px] truncate">{metadata.seriesDescription}</dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Modalidade</dt>
                <dd className="font-mono text-[11px] truncate">{metadata.modality}</dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Matriz</dt>
                <dd className="font-mono text-[11px] truncate">
                  {`${metadata.matrixDimensions[0]} x ${metadata.matrixDimensions[1]} x ${metadata.matrixDimensions[2]}`}
                </dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Voxel</dt>
                <dd className="font-mono text-[11px] truncate">
                  {`${metadata.voxelSize[0].toFixed(2)} x ${metadata.voxelSize[1].toFixed(2)} x ${metadata.voxelSize[2].toFixed(2)}`} mm
                </dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Espessura de corte</dt>
                <dd className="font-mono text-[11px] truncate">{metadata.sliceThickness} mm</dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-sidebar-border/50">
                <dt className="text-[11px] text-muted-foreground">Fabricante</dt>
                <dd className="font-mono text-[11px] truncate">{metadata.manufacturer}</dd>
              </div>
            </dl>

            <Separator />

            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Valores de imagem</h3>
              <div className="flex gap-4">
                <div className="flex flex-col">
                  <span className="font-mono text-lg">{windowWidth}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Largura (WW)</span>
                </div>
                <div className="flex flex-col">
                  <span className="font-mono text-lg">{windowCenter}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Centro (WL)</span>
                </div>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Densidade sob o cursor</h3>
              <div className="h-20 rounded-md border border-sidebar-border bg-background flex flex-col items-center justify-center">
                {cursorHU === null ? (
                  <>
                    <span className="font-mono text-2xl text-muted-foreground">?</span>
                    <span className="text-[10px] text-muted-foreground">Mova o cursor sobre um corte</span>
                  </>
                ) : (
                  <div className="flex items-baseline gap-1">
                    <span className="font-mono text-2xl text-primary" data-hu>
                      {cursorHU}
                    </span>
                    <span className="text-[10px] text-muted-foreground tracking-wider">HU</span>
                  </div>
                )}
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Medicoes
                </h3>
                {measurements.length > 0 && (
                  <button
                    type="button"
                    onClick={clearMeasurements}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    limpar todas
                  </button>
                )}
              </div>

              {measurements.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  Ative a Regua e clique em dois pontos, ou o Angulo e clique em tres, do
                  mesmo corte.
                </p>
              ) : (
                <ul className="flex flex-col gap-1" data-measure-list>
                  {measurements.map((m) => (
                    <li
                      key={m.id}
                      className="flex flex-col gap-0.5 rounded border border-sidebar-border bg-background px-2 py-1.5"
                      data-measure=""
                      data-measure-kind={m.kind}
                      data-measure-plane={m.plane}
                      data-measure-slice={m.slice}
                      {...(m.kind === "angle"
                        ? {
                            "data-deg": m.angleDeg,
                            "data-hu-a": m.huA,
                            "data-hu-b": m.huB,
                            "data-hu-c": m.huC,
                          }
                        : {
                            "data-mm": m.distanceMm,
                            "data-hu-a": m.huA,
                            "data-hu-b": m.huB,
                            "data-delta-hu": m.deltaHu,
                          })}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {PLANO_LABEL[m.plane]} {m.slice}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-[11px] text-primary">
                            {m.kind === "angle" ? formatDeg(m.angleDeg) : formatMm(m.distanceMm)}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remover medicao de ${
                              m.kind === "angle" ? formatDeg(m.angleDeg) : formatMm(m.distanceMm)
                            }`}
                            onClick={() => removeMeasurement(m.id)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      </div>
                      {/* Densidade das pontas. Na regua sao duas e o delta diz
                          qual cameca mais densa; no angulo sao tres e nao ha
                          par unico, entao o delta fica de fora. */}
                      <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                        <span className="text-muted-foreground">
                          {m.huA} &rarr; {m.huB}
                          {m.kind === "angle" ? ` &rarr; ${m.huC}` : ""} HU
                        </span>
                        {m.kind === "distance" && (
                          <span className="text-primary">&Delta;{formatDeltaHu(m.deltaHu)}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {lastMeasureError && (
                <p className="text-[10px] text-destructive" data-measure-error="">
                  {ERRO_MEDIDA[lastMeasureError]}
                </p>
              )}
            </div>

            <Separator />

            {/* Anotacoes: rotulo de texto amarrado a um ponto. */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Anotacoes
                </h3>
                {annotations.length > 0 && (
                  <button
                    type="button"
                    aria-label="Limpar anotacoes"
                    onClick={clearAnnotations}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    limpar
                  </button>
                )}
              </div>

              {/* Campo nativo, nao <Input> do design system: nao existe
                  components/ui/input.tsx neste projeto, e um input simples e o
                  elemento certo para texto de uma linha. */}
              <input
                type="text"
                value={annotationText}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setAnnotationText(e.target.value)
                }
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  // Enter marca a anotacao no crosshair atual, sem exigir
                  // clique no canvas: quem esta digitando nao deve ter que
                  // largar o campo e ir ate a imagem.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAnnotationAtCrosshair();
                  }
                }}
                placeholder="Escreva e clique na imagem"
                aria-label="Texto da anotacao"
                maxLength={MAX_ANNOTATION_CHARS}
                className="h-7 w-full rounded border border-sidebar-border bg-background px-2 text-[11px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                data-annotation-input=""
              />

              {activeTool === "Text" && annotationText.trim().length === 0 && (
                <p className="text-[10px] text-muted-foreground" data-annotation-hint="">
                  Escreva um texto antes de clicar: o rotulo precisa dizer alguma coisa.
                </p>
              )}

              {annotations.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  Ative Anotacao, escreva o rotulo e clique no ponto que ele nomeia.
                </p>
              ) : (
                <ul className="flex flex-col gap-1" data-annotation-list>
                  {annotations.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center justify-between gap-2 rounded border border-sidebar-border bg-background px-2 py-1.5"
                      data-annotation=""
                      data-annotation-plane={a.plane}
                      data-annotation-slice={a.slice}
                      data-annotation-u={a.u}
                      data-annotation-v={a.v}
                      data-annotation-text={a.text}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Tag className="size-3 shrink-0 text-muted-foreground" />
                        <span className="truncate text-[11px]" title={a.text}>
                          {a.text}
                        </span>
                        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">
                          {PLANO_LABEL[a.plane]} {a.slice}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remover anotacao ${a.text}`}
                        onClick={() => removeAnnotation(a.id)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Separator />

            {/* Relatorio: o exame inteiro, nao so o corte que esta na tela. */}
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Relatorio
              </h3>
              <pre
                data-report=""
                className="max-h-40 overflow-auto rounded border border-sidebar-border bg-background p-2 font-mono text-[10px] leading-tight whitespace-pre"
              >
                {report.texto}
              </pre>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-[11px]"
                  onClick={baixarCsv}
                >
                  <Download className="size-3" />
                  Baixar CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 text-[11px]"
                  onClick={copiarRelatorio}
                >
                  <Copy className="size-3" />
                  Copiar
                </Button>
              </div>
              {copiado && (
                <p className="text-[10px] text-muted-foreground" data-report-copied="">
                  Relatorio copiado.
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="p-4 mt-auto">
        <div className="bg-accent/40 rounded p-2 flex gap-2 items-start">
          <Lock className="size-3 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-[10px] text-muted-foreground">
            Dados processados localmente no navegador. Nenhum arquivo é enviado a um servidor.
          </p>
        </div>
      </div>
    </aside>
  );
}
