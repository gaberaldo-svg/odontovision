import { create } from "zustand";
import { ViewportType, Tool, Preset, ExamMetadata, MOCK_EXAM, MOCK_SLICE_COUNT } from "@/lib/mock-data";
import type { DicomMeta, DicomVolume, Plane } from "@/lib/dicom/types";
import { autoWindow } from "@/lib/dicom/volume";
import { buildMeasurement, type Measurement, type MeasureError } from "@/lib/dicom/measure";

/** Voxel apontado pelos tres viewports ao mesmo tempo. */
export interface Crosshair {
  x: number;
  y: number;
  z: number;
}

/** Resumo da montagem da serie, para a sidebar e o console. */
export interface SeriesInfo {
  orderedBy: "instanceNumber" | "imagePosition" | "fileName";
  fileCount: number;
  skipped: { fileName: string; reason: string }[];
}

interface ViewerState {
  activeTool: Tool;
  activePreset: Preset | null;
  windowWidth: number;
  windowCenter: number;
  /** Indice do corte em cada plano. Somados, formam o crosshair: (x,y,z). */
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
  /** Como a serie foi ordenada, ou null se veio um unico arquivo. */
  seriesInfo: SeriesInfo | null;
  cursorHU: number | null;
  isDemoLoaded: boolean;
  activeViewport: ViewportType;
  loadError: string | null;
  /** Regras confirmadas, com o comprimento ja em mm. */
  measurements: Measurement[];
  /** Primeiro ponto de uma regua em andamento, enquanto a tool Regua esta ativa. */
  measureDraft: { u: number; v: number } | null;
  /** Recusa do ultimo clique, para a UI explicar em vez de ignorar. */
  lastMeasureError: MeasureError | null;
  /** Contador para os ids das regras; nunca reutiliza id apagado. */
  lastMeasureId: number;

  setActiveTool: (tool: Tool) => void;
  setPreset: (preset: Preset) => void;
  setWindowLevel: (ww: number, wc: number) => void;
  setSlice: (viewport: ViewportType, index: number) => void;
  /** Move o crosshair: atualiza os tres planos de uma vez. */
  setCrosshair: (x: number, y: number, z: number) => void;
  setCursorHU: (hu: number | null) => void;
  /**
   * Clique com a regua ativa: o primeiro fixa a origem, o segundo fecha a
   * medida. Fora do par a ancora continua de pe, para o usuario corrigir.
   */
  addMeasurement: (plane: Plane, slice: number, u: number, v: number) => void;
  removeMeasurement: (id: number) => void;
  clearMeasurements: () => void;
  cancelMeasureDraft: () => void;
  toggleSidebar: () => void;
  loadDemoExam: () => void;
  /** Entra com o resultado real do worker de DICOM. */
  loadVolume: (meta: DicomMeta, volume: DicomVolume | null, series?: SeriesInfo | null) => void;
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
  seriesInfo: null,
  cursorHU: null,
  isDemoLoaded: false,
  activeViewport: "Axial" as ViewportType,
  loadError: null as string | null,
  measurements: [] as Measurement[],
  measureDraft: null as { u: number; v: number } | null,
  lastMeasureError: null as MeasureError | null,
  lastMeasureId: 0,
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

/**
 * Numero de cortes de cada plano para um volume real.
 * Coronal percorre Y (rows) e Sagital percorre X (columns): sao as dimensoes
 * da matriz, nao a contagem de cortes.
 */
function planeSliceCounts(volume: DicomVolume): Record<ViewportType, number> {
  return {
    Axial: Math.max(1, volume.slices),
    Coronal: Math.max(1, volume.rows),
    Sagital: Math.max(1, volume.columns),
  };
}

export const useViewerStore = create<ViewerState>((set) => ({
  ...initialState,

  setActiveTool: (tool) => set((state) => ({
    activeTool: tool,
    // Sair da regua abandona a ancora: um ponto solto esperando o segundo
    // clique sobreviveria a troca de tool e travaria a proxima medicao.
    measureDraft: tool === "Caliper" ? state.measureDraft : null,
    lastMeasureError: null,
  })),

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

  // Os indices de fatia ja sao as coordenadas do crosshair: o plano Axial
  // fixa z, Coronal fixa y e Sagital fixa x. Mover o crosshair e escrever
  // nos tres de uma vez, sem estado duplicado para sair de sincronia.
  setCrosshair: (x, y, z) => set((state) => {
    const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max - 1));
    return {
      slices: {
        Axial: clamp(z, state.maxSlices.Axial),
        Coronal: clamp(y, state.maxSlices.Coronal),
        Sagital: clamp(x, state.maxSlices.Sagital),
      },
    };
  }),

  setCursorHU: (cursorHU) => set({ cursorHU }),

  addMeasurement: (plane, slice, u, v) => set((state) => {
    const point = { u, v };
    const draft = state.measureDraft;
    // Sem ancora, o clique abre uma. A origem sobrevive a um clique invalido:
    // errar o segundo ponto e comum, e perder a origem tambem.
    if (!draft) return { measureDraft: point, lastMeasureError: null };

    const volume = state.volume;
    if (!volume) return { measureDraft: null, lastMeasureError: null };

    const id = state.lastMeasureId + 1;
    const built = buildMeasurement(volume, plane, slice, draft, point, id);
    if (!built.ok) return { lastMeasureError: built.error };

    return {
      measurements: [...state.measurements, built.measurement],
      measureDraft: null,
      lastMeasureError: null,
      lastMeasureId: id,
    };
  }),

  removeMeasurement: (id) => set((state) => ({
    measurements: state.measurements.filter((m) => m.id !== id),
  })),

  clearMeasurements: () => set({ measurements: [], measureDraft: null, lastMeasureError: null }),

  cancelMeasureDraft: () => set({ measureDraft: null, lastMeasureError: null }),

  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  loadDemoExam: () => set({
    metadata: MOCK_EXAM,
    dicomMeta: null,
    volume: null,
    seriesInfo: null,
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

loadVolume: (meta, volume, series) => set((state) => {
    // Com volume de verdade os tres planos abrem: Coronal percorre Y e
    // Sagital percorre X. Um .dcm solto tem slices = 1, e ai so o axial
    // tem dado — os outros ficam marcados como indisponiveis na UI.
    const maxSlices: Record<ViewportType, number> = volume
      ? planeSliceCounts(volume)
      : MOCK_SLICE_COUNT;

    // Se o exame nao traz janela propria, derivamos uma que caiba no volume.
    const derived = volume ? autoWindow(volume) : null;
    const windowWidth = meta.windowWidth ?? derived?.windowWidth ?? state.windowWidth;
    const windowCenter = meta.windowCenter ?? derived?.windowCenter ?? state.windowCenter;

    // Abrimos pelo centro do volume, e nao pelo indice 0, para o exame nao
    // comecar no ar ao redor.
    const counts = maxSlices;

    return {
      metadata: toExamMetadata(meta, volume),
      dicomMeta: meta,
      volume,
      seriesInfo: series ?? null,
      isExamLoaded: true,
      isDemoLoaded: false,
      maxSlices: counts,
      loadError: null,
      windowWidth,
      windowCenter,
      activePreset: null,
      // As regras pertencem ao volume anterior: as distancias em mm so valem
      // para o espacamento do exame que as originou.
      measurements: [],
      measureDraft: null,
      lastMeasureError: null,
      slices: {
        Axial: Math.floor((counts.Axial - 1) / 2),
        Coronal: Math.floor((counts.Coronal - 1) / 2),
        Sagital: Math.floor((counts.Sagital - 1) / 2),
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
      Coronal: Math.floor((state.maxSlices.Coronal - 1) / 2),
      Sagital: Math.floor((state.maxSlices.Sagital - 1) / 2),
    },
  })),
}));
