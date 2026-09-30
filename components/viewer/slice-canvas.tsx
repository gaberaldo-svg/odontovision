"use client";

import React, { useEffect, useRef, useState } from "react";
import type { DicomVolume, Plane } from "@/lib/dicom/types";
import type { MeasureDraft, Measurement } from "@/lib/dicom/measure";
import { planeAspect, planeDimensions, planeSliceCount, planeSliceToImageData } from "@/lib/dicom/volume";
import { formatDeltaHu, formatHu, formatMm } from "@/lib/format";

export interface SliceCanvasProps {
  volume: DicomVolume;
  /** Plano ortogonal ou axial. Define como (u,v) viram coordenada de voxel. */
  plane: Plane;
  /** Corte exibido: z no axial, y no coronal, x no sagital. */
  slice: number;
  windowWidth: number;
  windowCenter: number;
  zoom: number;
  pan: { x: number; y: number };
  /** Posicao do crosshair no plano, em coordenadas de voxel. */
  crosshair: { u: number; v: number } | null;
  /** Tool Regua ativa: o clique vira ponto de medicao em vez de so crosshair. */
  caliper: boolean;
  /** Regras confirmadas deste plano e deste corte. */
  measurements: Measurement[];
  /** Previa da regua em andamento: origem ate o ponteiro. Null quando nao ha. */
  draft: MeasureDraft | null;
  onCrosshairMove: (u: number, v: number) => void;
  /** Clique com a regua ativa. */
  onMeasure: (u: number, v: number) => void;
  onDraftCancel: () => void;
  onHover: (u: number, v: number) => void;
  onHoverLeave: () => void;
}

/** Geometria de tela do ultimo quadro desenhado. */
interface Frame {
  scale: number;
  tx: number;
  ty: number;
  width: number;
  height: number;
}

export function SliceCanvas({
  volume,
  plane,
  slice,
  windowWidth,
  windowCenter,
  zoom,
  pan,
  crosshair,
  caliper,
  measurements,
  draft,
  onCrosshairMove,
  onMeasure,
  onDraftCancel,
  onHover,
  onHoverLeave,
}: SliceCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Reaproveitado entre redesenhos: recriar um canvas a cada ajuste de
  // W/L custaria alocacao e upload de textura desnecessarios.
  const auxRef = useRef<HTMLCanvasElement | null>(null);
  // O calculo do cursor precisa da MESMA transformacao do desenho. Guardar
  // aqui evita duplicar a conta e divergir quando o MPR entra na equacao.
  const frameRef = useRef<Frame | null>(null);
  // Pointer events continuam chegando depois do pointerup; o clique so vale
  // se o botao nao foi arrastado.
  const dragRef = useRef(false);

  const [size, setSize] = useState({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
          dpr,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Canvas precisa de dimensoes inteiras em pixels de dispositivo;
    // passar float gera uma faixa subpixel na borda.
    const dpr = size.dpr;
    canvas.width = Math.max(1, Math.round(size.width * dpr));
    canvas.height = Math.max(1, Math.round(size.height * dpr));
    // Definir width/height zera o transform, entao o scale vem depois.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size.width, size.height);

    // O eixo vertical dos planos MPR cobre Z, que tem espacamento proprio.
    // Sem este aspecto o coronal sai achatado pelo numero de cortes. O axial
    // fica com 1: o mesmo numero que o render usa, ver `planeAspect`.
    const aspect = planeAspect(volume, plane);
    const dims = planeDimensions(volume, plane);
    const safeSlice = Math.max(0, Math.min(slice, Math.max(0, planeSliceCount(volume, plane) - 1)));

    const minDim = Math.min(size.width, size.height);
    const dispW = dims.columns;
    const dispH = dims.rows * aspect;
    const scale = (minDim / Math.max(1, Math.max(dispW, dispH))) * zoom;

    const imgData = planeSliceToImageData(volume, plane, safeSlice, windowWidth, windowCenter, scale);

    if (!auxRef.current) auxRef.current = document.createElement("canvas");
    const auxCanvas = auxRef.current;
    if (auxCanvas.width !== imgData.width || auxCanvas.height !== imgData.height) {
      auxCanvas.width = imgData.width;
      auxCanvas.height = imgData.height;
    }
    const auxCtx = auxCanvas.getContext("2d");
    if (!auxCtx) return;

    auxCtx.putImageData(imgData, 0, 0);

    const tx = size.width / 2 - imgData.width / 2 + pan.x;
    const ty = size.height / 2 - imgData.height / 2 + pan.y;

    frameRef.current = { scale, tx, ty, width: imgData.width, height: imgData.height };

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, tx * dpr, ty * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(auxCanvas, 0, 0);

    if (crosshair) {
      drawCrosshair(ctx, crosshair.u * scale, crosshair.v * aspect * scale, imgData.width, imgData.height);
    }

    // As reguas entram no mesmo transform do desenho: o eixo v precisa do
    // mesmo `aspect` que a imagem, senao a linha sai na diagonal errada.
    for (const m of measurements) {
      drawRuler(
        ctx,
        { x: m.a.u * scale, y: m.a.v * aspect * scale },
        { x: m.b.u * scale, y: m.b.v * aspect * scale },
        formatMm(m.distanceMm),
        formatHu(m.huA),
        formatHu(m.huB),
        false,
        imgData.width,
        imgData.height,
      );
    }

    if (draft) {
      const origem = { x: draft.from.u * scale, y: draft.from.v * aspect * scale };
      const ponta = draft.to
        ? { x: draft.to.u * scale, y: draft.to.v * aspect * scale }
        : origem;
      drawRuler(
        ctx,
        origem,
        ponta,
        draft.distanceMm === null ? "" : formatMm(draft.distanceMm),
        // A previa so sabe o HU da origem: o da outra ponta so existe depois
        // do segundo clique, que e o que fecha a medida.
        formatHu(draft.huA),
        "",
        true,
        imgData.width,
        imgData.height,
      );
    }

    ctx.restore();
  }, [
    volume,
    plane,
    slice,
    windowWidth,
    windowCenter,
    zoom,
    pan.x,
    pan.y,
    crosshair?.u,
    crosshair?.v,
    measurements,
    draft,
    size.width,
    size.height,
    size.dpr,
  ]);

  /** Converte a posicao do ponteiro para coordenada de voxel do plano. */
  const toVoxel = (clientX: number, clientY: number) => {
    const frame = frameRef.current;
    const el = containerRef.current;
    if (!frame || !el || size.width === 0 || size.height === 0) return null;

    const rect = el.getBoundingClientRect();
    const { columns, rows } = planeDimensions(volume, plane);
    const aspect = planeAspect(volume, plane);
    const u = Math.floor((clientX - rect.left - frame.tx) / frame.scale);
    const v = Math.floor((clientY - rect.top - frame.ty) / (frame.scale * aspect));
    if (u < 0 || u >= columns || v < 0 || v >= rows) return null;
    return { u, v };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0) dragRef.current = true;
    const voxel = toVoxel(e.clientX, e.clientY);
    if (!voxel) return;
    onHover(voxel.u, voxel.v);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = false;
    const voxel = toVoxel(e.clientX, e.clientY);
    if (voxel) onCrosshairMove(voxel.u, voxel.v);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (dragRef.current) {
      dragRef.current = false;
      return;
    }
    const voxel = toVoxel(e.clientX, e.clientY);
    if (!voxel) return;
    onCrosshairMove(voxel.u, voxel.v);
    // A regua nasce no pointerup, que e onde o codigo ja sabe se foi clique
    // ou arrasto. No pointerdown um arrasto deixaria a origem no lugar.
    if (caliper) onMeasure(voxel.u, voxel.v);
  };

  // Com uma regua em andamento, Escape descarta a origem.
  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDraftCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, onDraftCancel]);

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%", backgroundColor: "black" }}
      role="img"
      aria-label={`Viewport ${plane} do exame DICOM`}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={onHoverLeave}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  );
}

/**
 * Crosshair no espaco da imagem (o transform ativo so tem translacao, entao
 * 1 unidade aqui equivale a 1 pixel de tela).
 */
function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  u: number,
  v: number,
  width: number,
  height: number,
) {
  const gap = 7;
  ctx.save();
  ctx.strokeStyle = "rgba(45, 212, 191, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Verticais
  const cx = Math.round(u) + 0.5;
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, v - gap);
  ctx.moveTo(cx, v + gap);
  ctx.lineTo(cx, height);

  // Horizontais
  const cy = Math.round(v) + 0.5;
  ctx.moveTo(0, cy);
  ctx.lineTo(u - gap, cy);
  ctx.moveTo(u + gap, cy);
  ctx.lineTo(width, cy);

  ctx.stroke();

  // Moldura: ajuda a ler a borda da imagem contra o fundo preto.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.restore();
}

/**
 * Rotulo com fundo, preso dentro da imagem.
 *
 * Um rotulo que sai da borda cai no tarja preta e some, e uma regua pode terminar
 * em qualquer ponto: por isso o clamp e feito aqui, uma vez, para os tres
 * rotulos da regua.
 */
function drawTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  width: number,
  height: number,
) {
  ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  const boxW = ctx.measureText(text).width + 8;
  const boxH = 15;
  const bx = Math.max(2, Math.min(x, width - boxW - 2));
  const by = Math.max(2, Math.min(y, height - boxH - 2));
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.fillStyle = "#facc15";
  ctx.fillText(text, bx + 4, by + boxH - 4);
}

/**
 * Regua em mm sobre a imagem: segmento, marcas de ponta, a distancia e o HU de
 * cada ponta.
 *
 * `dashed` marca a previa -- a ancora foi clicada mas a regua ainda nao foi
 * fechada. As coordenadas ja vem em pixels do espaco da imagem, entao esta
 * funcao nao sabe de voxel, aspect nem escala.
 */
function drawRuler(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  rotulo: string,
  huA: string,
  huB: string,
  dashed: boolean,
  width: number,
  height: number,
) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = dashed ? "rgba(250, 204, 21, 0.9)" : "rgba(250, 204, 21, 1)";
  ctx.setLineDash(dashed ? [4, 3] : []);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Ticks de 3px nas pontas, para a extremidade da leitura ficar exata.
  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.moveTo(p.x - 3, p.y - 3);
    ctx.lineTo(p.x + 3, p.y + 3);
    ctx.moveTo(p.x + 3, p.y - 3);
    ctx.lineTo(p.x - 3, p.y + 3);
    ctx.stroke();
  }

  // A distancia fica no meio da linha. Os dois HU ficam nas pontas, empurrados
  // para fora do segmento: se ficassem do mesmo lado, uma regua curta teria os
  // tres rotulos empilhados em cima um do outro.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (rotulo) drawTag(ctx, mx + 9, my - 19, rotulo, width, height);
  drawTag(ctx, a.x - 12, a.y - 19, huA, width, height);
  drawTag(ctx, b.x + 12, b.y - 19, huB, width, height);
  ctx.restore();
}