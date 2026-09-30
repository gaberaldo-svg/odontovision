"use client";

import React, { useEffect, useRef, useState } from "react";
import type { DicomVolume } from "@/lib/dicom/types";
import { sliceToImageData } from "@/lib/dicom/volume";

export interface SliceCanvasProps {
  volume: DicomVolume | null;
  slice: number;
  windowWidth: number;
  windowCenter: number;
  zoom: number;
  pan: { x: number; y: number };
  onCursorMove: (imageX: number, imageY: number) => void;
  onCursorLeave: () => void;
}

export function SliceCanvas({
  volume,
  slice,
  windowWidth,
  windowCenter,
  zoom,
  pan,
  onCursorMove,
  onCursorLeave,
}: SliceCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Reaproveitado entre redesenhos: recriar um canvas a cada ajuste de
  // W/L custaria alocacao e upload de textura desnecessarios.
  const auxRef = useRef<HTMLCanvasElement | null>(null);

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
    // Definir width/height zera a transform, entao o scale vem depois.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size.width, size.height);

    if (!volume) return;

    const safeSlice = slice >= 0 && slice < volume.slices ? slice : 0;
    const minDim = Math.min(size.width, size.height);
    const scale = (minDim / Math.max(volume.columns, volume.rows)) * zoom;

    const imgData = sliceToImageData(volume, safeSlice, windowWidth, windowCenter, scale);

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

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, tx * dpr, ty * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(auxCanvas, 0, 0);
    ctx.restore();
  }, [
    volume,
    slice,
    windowWidth,
    windowCenter,
    zoom,
    pan.x,
    pan.y,
    size.width,
    size.height,
    size.dpr,
  ]);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volume || size.width === 0 || size.height === 0) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    const minDim = Math.min(size.width, size.height);
    const scale = (minDim / Math.max(volume.columns, volume.rows)) * zoom;

    const imgW = Math.max(1, Math.round(volume.columns * scale));
    const imgH = Math.max(1, Math.round(volume.rows * scale));

    const tx = size.width / 2 - imgW / 2 + pan.x;
    const ty = size.height / 2 - imgH / 2 + pan.y;

    const imageX = (offsetX - tx) / scale;
    const imageY = (offsetY - ty) / scale;

    onCursorMove(imageX, imageY);
  };

  const handlePointerLeave = () => {
    if (!volume) return;
    onCursorLeave();
  };

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%", backgroundColor: "black" }}
      role="img"
      aria-label="Viewport do exame DICOM"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  );
}
