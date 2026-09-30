"use client";

import * as React from "react";
import { ViewportType } from "@/lib/mock-data";
import { useViewerStore } from "@/store/use-viewer-store";

interface DicomOverlayProps {
  viewport: ViewportType;
  slice: number;
  totalSlices: number;
}

export function DicomOverlay({ viewport, slice, totalSlices }: DicomOverlayProps) {
  const windowWidth = useViewerStore((state) => state.windowWidth);
  const windowCenter = useViewerStore((state) => state.windowCenter);
  const metadata = useViewerStore((state) => state.metadata);

  const sliceThickness = metadata?.sliceThickness ?? 1.5;
  const zPos = (slice * sliceThickness).toFixed(1);

  const getOrientation = (vp: ViewportType) => {
    const name = String(vp).toLowerCase();
    if (name.includes("axial")) return "R/L";
    if (name.includes("coronal")) return "R";
    if (name.includes("sagit")) return "A/P";
    return "";
  };

  return (
    <div className="absolute inset-0 pointer-events-none font-mono text-[10px] text-muted-foreground uppercase tracking-wider p-2 flex flex-col justify-between z-10">
      <div className="flex justify-between items-start">
        <div>
          <div>{String(viewport)}</div>
          <div>S {slice}/{Math.max(0, totalSlices - 1)}</div>
        </div>
        <div className="text-right">
          <div>W {windowWidth}</div>
          <div>L {windowCenter}</div>
        </div>
      </div>
      
      <div className="flex justify-between items-end pb-6">{/* pb-6 for slider padding */}
        <div>
          <div>Z: {zPos} mm</div>
        </div>
        <div className="text-right">
          <div>{getOrientation(viewport)}</div>
        </div>
      </div>
    </div>
  );
}
