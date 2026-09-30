"use client";

import { useViewerStore } from "@/store/use-viewer-store";
import { FileScan, Lock } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export function Sidebar() {
  const { isSidebarOpen, metadata, windowWidth, windowCenter, cursorHU } = useViewerStore();

  if (!isSidebarOpen) return null;

  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="p-3 border-b border-sidebar-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Exame</h2>
      </div>

      <div className="flex-1 overflow-auto p-4 flex flex-col gap-6">
        {!metadata ? (
          <div className="flex flex-col items-center justify-center gap-2 text-center py-8">
            <FileScan className="size-8 text-muted-foreground" />
            <p className="text-xs">Nenhum exame</p>
            <p className="text-[10px] text-muted-foreground">Carregue um exame para ver os metadados</p>
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
                    {/* Valor MOCK até a fase 2 */}
                    <span className="font-mono text-2xl text-primary">{cursorHU}</span>
                    <span className="text-[10px] text-muted-foreground tracking-wider">HU</span>
                  </div>
                )}
              </div>
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
