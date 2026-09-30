"use client";

import * as React from "react";
import { Layers, FileScan, AlertTriangle } from "lucide-react";
import { ViewportType } from "@/lib/mock-data";
import { huAt } from "@/lib/dicom/volume";
import { useViewerStore } from "@/store/use-viewer-store";
import { Crosshair } from "@/components/viewer/crosshair";
import { DicomOverlay } from "@/components/viewer/dicom-overlay";
import { SliceCanvas } from "@/components/viewer/slice-canvas";
import { Slider } from "@/components/ui/slider";

interface ViewportProps {
  viewport: ViewportType;
}

/** Coronal e Sagital exigem um volume ao longo de Z, que um .dcm solto nao tem. */
const NEEDS_VOLUME: ViewportType[] = ["Coronal", "Sagital"];

export function Viewport({ viewport }: ViewportProps) {
  const isExamLoaded = useViewerStore((state) => state.isExamLoaded);
  const volume = useViewerStore((state) => state.volume);
  const slices = useViewerStore((state) => state.slices);
  const maxSlices = useViewerStore((state) => state.maxSlices);
  const setSlice = useViewerStore((state) => state.setSlice);
  const setCursorHU = useViewerStore((state) => state.setCursorHU);
  const windowWidth = useViewerStore((state) => state.windowWidth);
  const windowCenter = useViewerStore((state) => state.windowCenter);
  const zoomLevel = useViewerStore((state) => state.zoomLevel);
  const panOffset = useViewerStore((state) => state.panOffset);

  const currentSlice = slices[viewport] || 0;
  const totalSlices = maxSlices[viewport] || 1;
  const needsVolume = NEEDS_VOLUME.includes(viewport);
  const unavailable = isExamLoaded && needsVolume && !volume;

  // HU sob o cursor, lido do volume real.
  const handleCursorMove = (imageX: number, imageY: number) => {
    if (!volume || needsVolume) return;
    const hu = huAt(volume, Math.floor(imageX), Math.floor(imageY), currentSlice);
    setCursorHU(Number.isNaN(hu) ? null : Math.round(hu));
  };

  const handleCursorLeave = () => {
    if (!volume || needsVolume) return;
    setCursorHU(null);
  };

  return (
    <div className="relative flex flex-col flex-1 min-w-0 overflow-hidden rounded-md border border-border bg-viewport aspect-square">
      {!isExamLoaded ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <FileScan className="w-8 h-8 mb-2 text-muted-foreground" />
          <p className="text-xs text-muted-foreground font-medium">Nenhum exame carregado</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[200px]">
            Abra um arquivo .dcm na barra lateral ou use o botão de exemplo
          </p>
        </div>
      ) : unavailable ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <AlertTriangle className="w-7 h-7 mb-2 text-muted-foreground/70" />
          <p className="text-xs text-muted-foreground font-medium">{viewport} indisponivel</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[220px]">
            Reconstruir este plano exige a serie completa de cortes.
            Carregue varios arquivos .dcm do mesmo exame.
          </p>
        </div>
      ) : volume && !needsVolume ? (
        <div className="flex-1 relative w-full h-full flex flex-col">
          <SliceCanvas
            volume={volume}
            slice={currentSlice}
            windowWidth={windowWidth}
            windowCenter={windowCenter}
            zoom={zoomLevel}
            pan={panOffset}
            onCursorMove={handleCursorMove}
            onCursorLeave={handleCursorLeave}
          />

          <DicomOverlay viewport={viewport} slice={currentSlice} totalSlices={totalSlices} />
          <Crosshair />

          <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 px-2 pb-1.5 pt-4 bg-gradient-to-t from-background/80 to-transparent z-20">
            <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <Slider
              value={[currentSlice]}
              min={0}
              max={Math.max(0, totalSlices - 1)}
              step={1}
              onValueChange={(val) =>
                setSlice(viewport, Array.isArray(val) ? val[0] : val)
              }
              className="flex-1"
            />
            <span className="font-mono text-[10px] text-muted-foreground shrink-0 min-w-[2ch] text-right">
              {currentSlice}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <FileScan className="w-7 h-7 mb-2 text-muted-foreground/70" />
          <p className="text-xs text-muted-foreground font-medium">Exame de demonstracao</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[220px]">
            Os metadados sao mockados. Abra um arquivo .dcm para ver a imagem real.
          </p>
        </div>
      )}
    </div>
  );
}
