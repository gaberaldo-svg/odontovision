"use client";

import * as React from "react";

export function Crosshair() {
  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
      {/* Horizontal line */}
      <div className="absolute top-1/2 left-0 right-0 h-[1px] -translate-y-1/2 bg-primary/40" />
      {/* Vertical line */}
      <div className="absolute top-0 bottom-0 left-1/2 w-[1px] -translate-x-1/2 bg-primary/40" />
    </div>
  );
}
