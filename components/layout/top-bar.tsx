"use client";

import {
  ScanLine,
  Contrast,
  Hand,
  Search,
  Ruler,
  RotateCcw,
  X,
  Upload,
  Sparkles,
  PanelRight,
} from "lucide-react";
import { useViewerStore } from "@/store/use-viewer-store";
import { TOOL_DESCRIPTIONS, W_L_PRESETS, Tool } from "@/lib/mock-data";
import { openFilePicker } from "@/lib/dicom/file-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

const TOOLS: { id: Tool; icon: React.ElementType }[] = [
  { id: "WindowLevel", icon: Contrast },
  { id: "Pan", icon: Hand },
  { id: "Zoom", icon: Search },
  { id: "Caliper", icon: Ruler },
];

export function TopBar() {
  const {
    activeTool,
    setActiveTool,
    activePreset,
    setPreset,
    isExamLoaded,
    clearExam,
    loadDemoExam,
    isSidebarOpen,
    toggleSidebar,
    resetView,
  } = useViewerStore();

  return (
    <div className="h-14 border-b border-border bg-card flex items-center gap-3 px-3 shrink-0">
      {/* Esquerda */}
      <div className="flex items-center gap-2 mr-auto">
        <ScanLine className="size-5 text-primary" />
        <span className="text-sm font-semibold tracking-tight">OdontoVision</span>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          DICOM
        </span>
      </div>

      {/* Centro */}
      <div className="flex items-center gap-1">
        <ToggleGroup
          value={[activeTool]}
          onValueChange={(val) => {
            if (val.length > 0) setActiveTool(val[0] as Tool);
          }}
        >
          {TOOLS.map((tool) => (
            <Tooltip key={tool.id}>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value={tool.id}
                    className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  >
                    <tool.icon className="size-4" />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent>{TOOL_DESCRIPTIONS[tool.id]}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon" onClick={resetView}>
                <RotateCcw className="size-4" />
              </Button>
            }
          />
          <TooltipContent>Restaurar visao</TooltipContent>
        </Tooltip>
      </div>

      {/* Direita */}
      <div className="flex items-center gap-2 ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                {activePreset ? activePreset.name : "W/L Padrao"}
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Presets W/L</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {W_L_PRESETS.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => setPreset(p)}>
                  <div className="flex flex-col">
                    <span>{p.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      W{p.windowWidth} L{p.windowCenter}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{p.hint}</span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {isExamLoaded && (
          <Button variant="outline" size="sm" onClick={clearExam}>
            <X className="size-4 mr-1" />
            Limpar
          </Button>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="default" size="sm" onClick={openFilePicker}>
                <Upload className="size-4 mr-1" />
                Carregar .dcm
              </Button>
            }
          />
          <TooltipContent>Abrir um arquivo .dcm local</TooltipContent>
        </Tooltip>

        {!isExamLoaded && (
          <Button variant="secondary" size="sm" onClick={loadDemoExam}>
            <Sparkles className="size-4 mr-1" />
            Exemplo
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className={isSidebarOpen ? "bg-accent" : ""}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
