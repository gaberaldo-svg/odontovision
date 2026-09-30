"use client";

import * as React from "react";
import { useViewerStore } from "@/store/use-viewer-store";
import { Viewport } from "@/components/viewer/viewport";
import { ViewportType } from "@/lib/mock-data";

export function MainPanel() {
  const maxSlices = useViewerStore((state) => state.maxSlices);
  
  // Mock de fatias totais pra interface
  const totalSlices = Object.values(maxSlices).reduce((a, b) => (a as number) + (b as number), 0);

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Visão MPR
        </h2>
        <div className="text-[10px] font-mono text-muted-foreground">
          TOTAL SLICES: {totalSlices}
        </div>
      </div>

      <div className="grid flex-1 min-h-0 gap-2 p-2 grid-cols-1 lg:grid-cols-3">
        <Viewport viewport={"Axial" as ViewportType} />
        <Viewport viewport={"Coronal" as ViewportType} />
        <Viewport viewport={"Sagital" as ViewportType} />
      </div>
    </div>
  );
}
