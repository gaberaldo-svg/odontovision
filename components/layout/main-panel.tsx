"use client";

import * as React from "react";
import { useViewerStore } from "@/store/use-viewer-store";
import { Viewport } from "@/components/viewer/viewport";
import { Viewport3D } from "@/components/viewer/viewport-3d";
import { ViewportType } from "@/lib/mock-data";

/**
 * Area de visualizacao: os tres planos MPR, ou a reconstrucao 3D.
 *
 * Sao modos ALTERNATIVOS, e nao um quarto viewport ao lado: quatro paineis
 * quadrados nao cabem numa tela sem ficarem minusculos, e o 3D e a visao que
 * o usuario quer em tela cheia quando abre.
 */
export function MainPanel() {
  const maxSlices = useViewerStore((state) => state.maxSlices);
  const volume = useViewerStore((state) => state.volume);
  const isDemoLoaded = useViewerStore((state) => state.isDemoLoaded);
  const [modo, setModo] = React.useState<"mpr" | "3d">("mpr");

  const totalSlices = Object.values(maxSlices).reduce((a, b) => (a as number) + (b as number), 0);

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {modo === "3d" ? "Reconstrução 3D" : "Visão MPR"}
        </h2>

        <div className="flex items-center gap-3">
          <div
            role="group"
            aria-label="Modo de visualização"
            data-view-mode={modo}
            className="flex items-center gap-1 rounded border border-border p-0.5"
          >
            {(["mpr", "3d"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setModo(m)}
                aria-pressed={modo === m}
                aria-label={m === "mpr" ? "Ver MPR" : "Ver 3D"}
                className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                  modo === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground">
            TOTAL SLICES: {totalSlices}
          </div>
        </div>
      </div>

      {modo === "3d" ? (
        <div className="flex flex-1 min-h-0 gap-2 p-2">
          <Viewport3D volume={volume} />
        </div>
      ) : (
        <div className="grid flex-1 min-h-0 gap-2 p-2 grid-cols-1 lg:grid-cols-3">
          <Viewport viewport={"Axial" as ViewportType} />
          <Viewport viewport={"Coronal" as ViewportType} />
          <Viewport viewport={"Sagital" as ViewportType} />
        </div>
      )}
      {/* Sem volume nao ha o que reconstruir; o modo 3D cairia num canvas
          vazio sem explicacao. */}
      {modo === "3d" && !volume && isDemoLoaded && (
        <p className="px-3 pb-2 text-[10px] text-muted-foreground">
          Carregue um exame para reconstruir em 3D.
        </p>
      )}
    </div>
  );
}
