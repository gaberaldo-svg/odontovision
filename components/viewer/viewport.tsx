"use client";

import * as React from "react";
import { Layers, FileScan, AlertTriangle } from "lucide-react";
import { ViewportType } from "@/lib/mock-data";
import type { Plane } from "@/lib/dicom/types";
import { planeHuAt, voxelFromPlane } from "@/lib/dicom/volume";
import { useViewerStore } from "@/store/use-viewer-store";
import { DicomOverlay } from "@/components/viewer/dicom-overlay";
import { SliceCanvas } from "@/components/viewer/slice-canvas";
import { Slider } from "@/components/ui/slider";

interface ViewportProps {
  viewport: ViewportType;
}

/** Identificador do plano no modulo de volume. O planoClinical e "sagital". */
const PLANE: Record<ViewportType, Plane> = {
  Axial: "axial",
  Coronal: "coronal",
  Sagital: "sagittal",
};

/**
 * Um .dcm solto tem slices = 1: nao existe eixo Z para reconstruir coronal e
 * sagital. A UI explica isso em vez de mostrar imagem vazia.
 */
function needsVolume(viewport: ViewportType): boolean {
  return viewport === "Coronal" || viewport === "Sagital";
}

export function Viewport({ viewport }: ViewportProps) {
  const isExamLoaded = useViewerStore((state) => state.isExamLoaded);
  const volume = useViewerStore((state) => state.volume);
  const slices = useViewerStore((state) => state.slices);
  const maxSlices = useViewerStore((state) => state.maxSlices);
  const setSlice = useViewerStore((state) => state.setSlice);
  const setCrosshair = useViewerStore((state) => state.setCrosshair);
  const setCursorHU = useViewerStore((state) => state.setCursorHU);
  const windowWidth = useViewerStore((state) => state.windowWidth);
  const windowCenter = useViewerStore((state) => state.windowCenter);
  const zoomLevel = useViewerStore((state) => state.zoomLevel);
  const panOffset = useViewerStore((state) => state.panOffset);

  const plane = PLANE[viewport];
  const currentSlice = slices[viewport] || 0;
  const totalSlices = maxSlices[viewport] || 1;
  const unavailable = Boolean(isExamLoaded && needsVolume(viewport) && (!volume || volume.slices < 2));

  // O crosshair vive nos proprios indices de fatia: Axial fixa z, Coronal
  // fixa y, Sagital fixa x. Entao cada plano sabe onde se posicionar.
  const crosshair = volume
    ? {
        Axial: { u: slices.Sagital, v: slices.Coronal },
        Coronal: { u: slices.Sagital, v: slices.Axial },
        Sagital: { u: slices.Coronal, v: slices.Axial },
      }[viewport]
    : null;

  const toVoxel = (u: number, v: number) => voxelFromPlane(plane, currentSlice, u, v);

  // HU sob o cursor, lido do volume real no plano que esta em foco.
  const handleHover = (u: number, v: number) => {
    if (!volume) return;
    const hu = planeHuAt(volume, plane, currentSlice, u, v);
    setCursorHU(Number.isNaN(hu) ? null : Math.round(hu));
  };

  // Clique move o crosshair: escreve nos tres planos ao mesmo tempo.
  const handleCrosshairMove = (u: number, v: number) => {
    if (!volume) return;
    const voxel = toVoxel(u, v);
    setCrosshair(voxel.x, voxel.y, voxel.z);
    const hu = planeHuAt(volume, plane, currentSlice, u, v);
    setCursorHU(Number.isNaN(hu) ? null : Math.round(hu));
  };

  return (
    <div
      data-viewport={viewport}
      data-plane={plane}
      className="relative flex flex-col flex-1 min-w-0 overflow-hidden rounded-md border border-border bg-viewport aspect-square"
    >
      {!isExamLoaded ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <FileScan className="w-8 h-8 mb-2 text-muted-foreground" aria-hidden />
          <p className="text-xs text-muted-foreground font-medium">Nenhum exame carregado</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[200px]">
            Abra um .dcm ou uma serie de cortes na barra lateral, ou use o botao de exemplo
          </p>
        </div>
      ) : unavailable ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <AlertTriangle className="w-7 h-7 mb-2 text-muted-foreground/70" aria-hidden />
          <p className="text-xs text-muted-foreground font-medium">{viewport} indisponivel</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[220px]">
            Reconstruir este plano exige a serie completa de cortes. Carregue varios
            arquivos .dcm do mesmo exame ao mesmo tempo.
          </p>
        </div>
      ) : volume ? (
        <div className="flex-1 relative w-full h-full flex flex-col">
          <SliceCanvas
            volume={volume}
            plane={plane}
            slice={currentSlice}
            windowWidth={windowWidth}
            windowCenter={windowCenter}
            zoom={zoomLevel}
            pan={panOffset}
            crosshair={crosshair}
            onCrosshairMove={handleCrosshairMove}
            onHover={handleHover}
            onHoverLeave={() => setCursorHU(null)}
          />

          <DicomOverlay viewport={viewport} slice={currentSlice} totalSlices={totalSlices} />

          <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-2 pb-1.5 pt-4 bg-gradient-to-t from-background/80 to-transparent z-20">
            <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
            <Slider
              value={[currentSlice]}
              min={0}
              max={Math.max(0, totalSlices - 1)}
              step={1}
              onValueChange={(val) =>
                setSlice(viewport, Array.isArray(val) ? val[0] : val)
              }
              className="flex-1"
              aria-label={`Corte ${viewport}`}
            />
            <span
              data-slice-index={currentSlice}
              data-slice-count={totalSlices}
              className="font-mono text-[10px] text-muted-foreground shrink-0 min-w-[2ch] text-right"
            >
              {currentSlice}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <FileScan className="w-7 h-7 mb-2 text-muted-foreground/70" aria-hidden />
          <p className="text-xs text-muted-foreground font-medium">Exame de demonstracao</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[220px]">
            Os metadados sao mockados. Abra um .dcm para ver a imagem real.
          </p>
        </div>
      )}
    </div>
  );
}