export type ViewportType = "Axial" | "Coronal" | "Sagital";
export type Tool = "WindowLevel" | "Pan" | "Zoom" | "Caliper" | "ResetView";

export interface Preset {
  id: string;
  name: string;
  windowWidth: number;
  windowCenter: number;
  hint: string;
}

export interface ExamMetadata {
  patientName: string;
  patientId: string;
  studyDate: string;
  seriesDescription: string;
  matrixDimensions: [number, number, number];
  voxelSize: [number, number, number];
  sliceThickness: number;
  modality: string;
  manufacturer: string;
}

export const MOCK_EXAM: ExamMetadata = {
  patientName: "ANONIMO",
  patientId: "CBCT-2024-0142",
  studyDate: "2024-03-15",
  seriesDescription: "CBCT - Maxilar Superior",
  matrixDimensions: [512, 512, 180],
  voxelSize: [0.25, 0.25, 0.25],
  sliceThickness: 0.25,
  modality: "CT",
  manufacturer: "ORTOPEDICO",
};

export const MOCK_SLICE_COUNT: Record<ViewportType, number> = {
  Axial: 180,
  Coronal: 512,
  Sagital: 512,
};

export const W_L_PRESETS: Preset[] = [
  {
    id: "osso_geral",
    name: "Osso Geral",
    windowWidth: 2000,
    windowCenter: 450,
    hint: "Visao geral da densidade ossea",
  },
  {
    id: "esmalte_tecido_duro",
    name: "Esmalte / Tecido Duro",
    windowWidth: 3500,
    windowCenter: 1000,
    hint: "Avaliacao de tecidos duros",
  },
  {
    id: "tecido_mole",
    name: "Tecido Mole",
    windowWidth: 400,
    windowCenter: 40,
    hint: "Visualizacao de tecidos moles",
  },
];

export const TOOL_LABELS: Record<Tool, string> = {
  WindowLevel: "Janela/Contraste",
  Pan: "Navegar",
  Zoom: "Zoom",
  Caliper: "Regua",
  ResetView: "Restaurar Visao",
};

export const TOOL_DESCRIPTIONS: Record<Tool, string> = {
  WindowLevel: "Ajustar o brilho e contraste",
  Pan: "Mover a imagem",
  Zoom: "Aproximar ou afastar a imagem",
  Caliper: "Medir distancias em mm",
  ResetView: "Voltar a visualizacao inicial",
};
