"use client";

import { useViewerStore } from "@/store/use-viewer-store";
import { FileScan, Lock, X } from "lucide-react";
import type { Plane } from "@/lib/dicom/types";
import type { MeasureError } from "@/lib/dicom/measure";
import { formatDeg, formatDeltaHu, formatMm } from "@/lib/format";
import { Separator } from "@/components/ui/separator";
import { FileLoader } from "@/components/layout/file-loader";

/** "sagittal" e o valor interno; na UI a viewport se chama "Sagital". */
const PLANO_LABEL: Record<Plane, string> = {
  axial: "Axial",
  coronal: "Coronal",
  sagittal: "Sagital",
};

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
  } = useViewerStore();

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
