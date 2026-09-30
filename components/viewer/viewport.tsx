"use client";

import * as React from "react";
import { Layers, FileScan } from "lucide-react";
import { ViewportType } from "@/lib/mock-data";
import { useViewerStore } from "@/store/use-viewer-store";
import { Crosshair } from "@/components/viewer/crosshair";
import { DicomOverlay } from "@/components/viewer/dicom-overlay";
import { Slider } from "@/components/ui/slider";

interface ViewportProps {
  viewport: ViewportType;
}

export function Viewport({ viewport }: ViewportProps) {
  const isExamLoaded = useViewerStore((state) => state.isExamLoaded);
  const slices = useViewerStore((state) => state.slices);
  const maxSlices = useViewerStore((state) => state.maxSlices);
  const setSlice = useViewerStore((state) => state.setSlice);
  const setCursorHU = useViewerStore((state) => state.setCursorHU);

  const currentSlice = slices[viewport as keyof typeof slices] || 0;
  const totalSlices = maxSlices[viewport as keyof typeof maxSlices] || 1;

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isExamLoaded) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Fase 1: Mock de HU simulando valor radionumerico
    setCursorHU(-100 + Math.round(x / 2));
  };

  const handleMouseLeave = () => {
    if (!isExamLoaded) return;
    setCursorHU(null);
  };

  return (
    <div className="relative flex flex-col flex-1 min-w-0 overflow-hidden rounded-md border border-border bg-viewport aspect-square">
      {!isExamLoaded ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <FileScan className="w-8 h-8 mb-2 text-muted-foreground" />
          <p className="text-xs text-muted-foreground font-medium">Nenhum exame carregado</p>
          <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[200px]">
            Arraste arquivos .dcm ou use o botão de exemplo
          </p>
        </div>
      ) : (
        <div 
          className="flex-1 relative w-full h-full flex flex-col"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* Fase 2: container real da imagem será colocado aqui */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-white/5 via-transparent to-transparent opacity-30 pointer-events-none" />
          
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
      )}
    </div>
  );
}
