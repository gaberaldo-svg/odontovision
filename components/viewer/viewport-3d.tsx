"use client";

import * as React from "react";
import { Move3d } from "lucide-react";
import type { DicomVolume } from "@/lib/dicom/types";
import { renderMip, semiExtremos } from "@/lib/dicom/volume3d";
import { voxelSizeMm } from "@/lib/dicom/volume";

/**
 * Viewport 3D por MIP, com rotacao por arraste.
 *
 * O render e um `putImageData`: sem projecao de perspectiva, sem luz, sem
 * sombra. O que o usuario ve e o pico de HU de cada raio, e nao uma cena 3D
 * de verdade -- e isso que o torna confiavel, porque a mesma conta produz o
 * mesmo numero.
 *
 * **Limiar e zoom sao a interface, e o threshold e o que importa.** O padrao de
 * osso e o que separa o maxilar do ar; sem ele a imagem sai preta.
 */
export function Viewport3D({ volume }: { volume: DicomVolume | null }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [tamanho, setTamanho] = React.useState({ w: 0, h: 0 });
  const [yaw, setYaw] = React.useState(-0.7);
  const [pitch, setPitch] = React.useState(-0.35);
  const [zoom, setZoom] = React.useState(6);
  const [limiarHu, setLimiarHu] = React.useState(300);
  const arrastando = React.useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  React.useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      // Dpr entra na conta: sem isso o 3D sai borraso em tela retina, enquanto
      // o 2D continua nitido -- e a diferenca fica visivel lado a lado.
      setTamanho({ w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Um phantom 64x64x32 mede 16 x 16 x 31 mm. O zoom inicial enquadra a maior
  // dimensao com uma folga, para nenhuma rotacao empurrar a imagem para fora.
  React.useEffect(() => {
    if (!volume) return;
    const s = voxelSizeMm(volume);
    const maior = Math.max(volume.columns * s.x, volume.rows * s.y, volume.slices * s.z);
    if (tamanho.w > 0) setZoom(Math.min(tamanho.w, tamanho.h) / (maior * 1.25));
  }, [volume, tamanho.w, tamanho.h]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !volume || tamanho.w === 0 || tamanho.h === 0) return;
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    canvas.width = tamanho.w * dpr;
    canvas.height = tamanho.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const t0 = performance.now();
    const data = renderMip(volume, {
      width: canvas.width,
      height: canvas.height,
      yaw,
      pitch,
      zoom: zoom * dpr,
      limiarHu,
      windowWidth: 1600,
      windowCenter: 600,
    });
    ctx.putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
    const ms = performance.now() - t0;
    if (process.env.NODE_ENV !== "production") {
      // Custo por quadro em ms: o render roda em JS puro, e saber se cabe
      // arrastar em maquina fraca e o que decide se isto vira WebGL depois.
      canvas.dataset.renderMs = ms.toFixed(0);
    }
  }, [volume, tamanho, yaw, pitch, zoom, limiarHu]);

  const semi = volume ? semiExtremos(volume) : null;

  return (
    <div
      data-viewport="Volume3D"
      data-plane="3d"
      data-3d-yaw={yaw.toFixed(3)}
      data-3d-pitch={pitch.toFixed(3)}
      data-3d-threshold={limiarHu}
      className="relative flex flex-1 min-w-0 overflow-hidden rounded-md border border-border bg-viewport"
    >
      {!volume ? (
        <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
          <Move3d className="mb-2 size-8 text-muted-foreground" aria-hidden />
          <p className="text-xs font-medium text-muted-foreground">Sem volume para reconstruir</p>
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Reconstrucao 3D do volume"
          style={{ display: "block", width: "100%", height: "100%", cursor: "grab", touchAction: "none" }}
          onPointerDown={(e) => {
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            arrastando.current = { x: e.clientX, y: e.clientY, yaw, pitch };
          }}
          onPointerMove={(e) => {
            const a = arrastando.current;
            if (!a) return;
            setYaw(a.yaw + (e.clientX - a.x) * 0.01);
            setPitch(Math.max(-1.55, Math.min(1.55, a.pitch + (e.clientY - a.y) * 0.01)));
          }}
          onPointerUp={() => { arrastando.current = null; }}
          onPointerCancel={() => { arrastando.current = null; }}
          onWheel={(e) => {
            setZoom((z) => Math.max(1, Math.min(60, z * (e.deltaY < 0 ? 1.12 : 0.89))));
          }}
        />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-2 font-mono text-[10px] text-muted-foreground">
        <span>3D (MIP) · arraste para girar · roda para zoom</span>
        {semi && (
          <span>
            {(semi.x * 2).toFixed(1)} × {(semi.y * 2).toFixed(1)} × {(semi.z * 2).toFixed(1)} mm
          </span>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 p-2 font-mono text-[10px] text-muted-foreground">
        <label className="flex flex-1 items-center gap-2">
          <span className="shrink-0">limiar</span>
          <input
            type="range"
            min={-900}
            max={2500}
            step={10}
            value={limiarHu}
            onChange={(e) => setLimiarHu(Number(e.target.value))}
            aria-label="Limiar de HU"
            className="h-1 flex-1 accent-primary"
          />
          <span className="w-12 shrink-0 text-right text-foreground">{limiarHu} HU</span>
        </label>
        <button
          type="button"
          onClick={() => { setYaw(-0.7); setPitch(-0.35); }}
          className="pointer-events-auto shrink-0 text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          recentralizar
        </button>
      </div>
    </div>
  );
}
