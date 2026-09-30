import { create } from "zustand";
import { ViewportType, Tool, Preset, ExamMetadata, MOCK_EXAM, MOCK_SLICE_COUNT } from "@/lib/mock-data";

interface ViewerState {
  activeTool: Tool;
  activePreset: Preset | null;
  windowWidth: number;
  windowCenter: number;
  slices: Record<ViewportType, number>;
  maxSlices: Record<ViewportType, number>;
  zoomLevel: number;
  panOffset: { x: number; y: number };
  isSidebarOpen: boolean;
  isExamLoaded: boolean;
  metadata: ExamMetadata | null;
  cursorHU: number | null;
  isDemoLoaded: boolean;
  activeViewport: ViewportType;

  setActiveTool: (tool: Tool) => void;
  setPreset: (preset: Preset) => void;
  setWindowLevel: (ww: number, wc: number) => void;
  setSlice: (viewport: ViewportType, index: number) => void;
  setCursorHU: (hu: number | null) => void;
  toggleSidebar: () => void;
  loadDemoExam: () => void;
  clearExam: () => void;
  resetView: () => void;
}

const initialState = {
  activeTool: "WindowLevel" as Tool,
  activePreset: null,
  windowWidth: 400,
  windowCenter: 40,
  slices: { Axial: 0, Coronal: 0, Sagital: 0 },
  maxSlices: MOCK_SLICE_COUNT,
  zoomLevel: 1,
  panOffset: { x: 0, y: 0 },
  isSidebarOpen: true,
  isExamLoaded: false,
  metadata: null,
  cursorHU: null,
  isDemoLoaded: false,
  activeViewport: "Axial" as ViewportType,
};

export const useViewerStore = create<ViewerState>((set) => ({
  ...initialState,

  setActiveTool: (tool) => set({ activeTool: tool }),

  setPreset: (preset) => set({
    activePreset: preset,
    windowWidth: preset.windowWidth,
    windowCenter: preset.windowCenter,
    activeTool: "WindowLevel",
  }),

  setWindowLevel: (windowWidth, windowCenter) => set({ windowWidth, windowCenter }),

  setSlice: (viewport, index) => set((state) => {
    const maxIndex = state.maxSlices[viewport] - 1;
    const clampedIndex = Math.max(0, Math.min(index, maxIndex));
    return { slices: { ...state.slices, [viewport]: clampedIndex } };
  }),

  setCursorHU: (cursorHU) => set({ cursorHU }),

  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  loadDemoExam: () => set({
    metadata: MOCK_EXAM,
    isExamLoaded: true,
    maxSlices: MOCK_SLICE_COUNT,
    isDemoLoaded: true,
    slices: {
      Axial: Math.floor(MOCK_SLICE_COUNT.Axial / 2),
      Coronal: Math.floor(MOCK_SLICE_COUNT.Coronal / 2),
      Sagital: Math.floor(MOCK_SLICE_COUNT.Sagital / 2),
    },
  }),

  clearExam: () => set((state) => ({
    ...initialState,
    isSidebarOpen: state.isSidebarOpen, // Preserve sidebar state
  })),

  resetView: () => set((state) => ({
    zoomLevel: 1,
    panOffset: { x: 0, y: 0 },
    slices: {
      Axial: Math.floor(state.maxSlices.Axial / 2),
      Coronal: Math.floor(state.maxSlices.Coronal / 2),
      Sagital: Math.floor(state.maxSlices.Sagital / 2),
    },
  })),
}));
