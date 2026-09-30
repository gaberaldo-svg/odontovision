"use client";

import { TopBar } from "@/components/layout/top-bar";
import { Sidebar } from "@/components/layout/sidebar";
import { MainPanel } from "@/components/layout/main-panel";

export default function Page() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 min-w-0 flex">
          <MainPanel />
        </div>
        <Sidebar />
      </div>
    </div>
  );
}
