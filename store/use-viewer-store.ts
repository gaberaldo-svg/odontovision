import { create } from "zustand";
import { ViewportType, Tool, Preset, ExamMetadata, MOCK_EXAM, MOCK_SLICE_COUNT } from "@/lib/mock-data";
import type { DicomMeta, DicomVolume } from "@/lib/dicom/types";
import { autoWindow } from "@/lib/dicom/volume";

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
  /** Metadados apresentados na sidebar (reais quando ha volume carregado). */
  metadata: ExamMetadata | null;
  /** Metadados DICOM crus, para a tela de detalhes. */
  dicomMeta: DicomMeta | null;
  /** Volume real, ou null enquanto so houver o exame de demonstracao. */
  volume: DicomVolume | null;
  cursorHU: number | null;
  isDemoLoaded: boolean;
  activeViewport: ViewportType;
  loadError: string | null;

  setActiveTool: (tool: Tool) => void;
  setPreset: (preset: Preset) => void;
  setWindowLevel: (ww: number, wc: number) => void;
  setSlice: (viewport: ViewportType, index: number) => void;
  setCursorHU: (hu: number | null) => void;
  toggleSidebar: () => void;
  loadDemoExam: () => void;
  /** Entra com o resultado real do worker de DICOM. */
  loadVolume: (meta: DicomMeta, volume: DicomVolume | null) => void;
  setLoadError: (message: string | null) => void;
  clearExam: () => void;
  resetView: () => void;
}

const initialState = {
  activeTool: "WindowLevel" as Tool,
  activePreset: null,
  windowWidth: 400,
  windowCenter: 40,
  slices: { Axial: 0, Coronal: 0, Sagital: 0 } as Record<ViewportType, number>,
  maxSlices: MOCK_SLICE_COUNT,
  zoomLevel: 1,
  panOffset: { x: 0, y: 0 },
  isSidebarOpen: true,
  isExamLoaded: false,
  metadata: null,
  dicomMeta: null,
  volume: null,
  cursorHU: null,
  isDemoLoaded: false,
  activeViewport: "Axial" as ViewportType,
  loadError: null as string | null,
};

/** Converte os metadados DICOM no formato que a sidebar ja consome. */
function toExamMetadata(meta: DicomMeta, volume: DicomVolume | null): ExamMetadata {
  const spacing = meta.pixelSpacing;
  const zSpacing = volume?.sliceSpacing ?? meta.spacingBetweenSlices ?? null;
  return {
    patientName: meta.patientName ?? "-",
    patientId: meta.patientId ?? "-",
    studyDate: meta.studyDate ?? "-",
    seriesDescription: meta.seriesDescription ?? "-",
    matrixDimensions: [meta.columns, meta.rows, volume?.slices ?? meta.numberOfFrames],
    voxelSize: [spacing?.[0] ?? 1, spacing?.[1] ?? 1, zSpacing ?? 1],
    sliceThickness: meta.sliceThickness ?? zSpacing ?? 0,
    modality: meta.modality ?? "-",
    manufacturer: meta.manufacturer ?? "-",
  };
}

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
    dicomMeta: null,
    volume: null,
    isExamLoaded: true,
    maxSlices: MOCK_SLICE_COUNT,
    isDemoLoaded: true,
    loadError: null,
    slices: {
      Axial: Math.floor(MOCK_SLICE_COUNT.Axial / 2),
      Coronal: Math.floor(MOCK_SLICE_COUNT.Coronal / 2),
      Sagital: Math.floor(MOCK_SLICE_COUNT.Sagital / 2),
    },
  }),

  loadVolume: (meta, volume) => set((state) => {
    // Uma fatia unica nao permite reconstruir coronal/sagital, que precisam
    // de um volume ao longo de Z. Esses viewports ficam desabilitados ate
    //_phase_ de leitura em multiplos arquivos.
    const axialSlices = Math.max(1, volume?.slices ?? meta.numberOfFrames);
    const hasVolume = volume !== null;
    const maxSlices: Record<ViewportType, number> = hasVolume
      ? { Axial: axialSlices, Coronal: 1, Sagital: 1 }
      : MOCK_SLICE_COUNT;

    // Se o exame nao traz janela propia, derivamos uma que caiba no volume.
    const derived = hasVolume ? autoWindow(volume) : null;
    const windowWidth = meta.windowWidth ?? derived?.windowWidth ?? state.windowWidth;
    const windowCenter = meta.windowCenter ?? derived?.windowCenter ?? state.windowCenter;

    return {
      metadata: toExamMetadata(meta, volume),
      dicomMeta: meta,
      volume,
      isExamLoaded: true,
      isDemoLoaded: false,
      maxSlices,
      loadError: null,
      windowWidth,
      windowCenter,
      activePreset: null,
      slices: {
        Axial: Math.floor((axialSlices - 1) / 2),
        Coronal: 0,
        Sagital: 0,
      },
    };
  }),

  setLoadError: (message) => set({ loadError: message, isExamLoaded: false }),

  clearExam: () => set((state) => ({
    ...initialState,
    isSidebarOpen: state.isSidebarOpen, // preserva o estado da sidebar
  })),

  resetView: () => set((state) => ({
    zoomLevel: 1,
    panOffset: { x: 0, y: 0 },
    slices: {
      Axial: Math.floor((state.maxSlices.Axial - 1) / 2),
      Coronal: 0,
      Sagital: 0,
    },
  })),
}));
