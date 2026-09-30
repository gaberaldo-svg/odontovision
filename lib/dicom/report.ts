import type { Measurement } from "./measure.ts";
import { formatDeg, formatDeltaHu, formatMm, formatHu, PLANO_LABEL } from "../format.ts";
import type { Plane } from "./types.ts";

/**
 * O minimo de metadados que o relatorio precisa. `ExamMetadata` satisfaz
 * isto por forma estrutural, entao quem chama nao precisa montar um objeto
 * proprio -- e o relatorio nao depende do modulo de mock.
 */
export interface ReportMeta {
  patientName: string;
  patientId: string;
  studyDate: string;
  seriesDescription: string;
  modality: string;
  voxelSize: [number, number, number];
}

export interface Report {
  /** Relatorio alinhado para leitura humana. */
  texto: string;
  /** CSV com toda a celula entre aspas, para planilha e para importar. */
  csv: string;
  contagem: number;
}

/** Ordem de apresentacao: axial, coronal, sagital, e dentro deles o corte. */
const ORDEM_PLANO: Plane[] = ["axial", "coronal", "sagittal"];

/**
 * O relatorio lista TODAS as medicoes, nao so as que estao desenhadas na tela.
 *
 * A lista lateral e por plano e por corte; o relatorio e do exame inteiro. Sao
 * coisas diferentes de proposito: trocar de corte esconde a regua para nao
 * poluir a imagem, mas apagar do relatorio uma medicao que o clinico acabou de
 * fazer seria perder trabalho. O que o medico mediu e o que ele exporta.
 */
function ordenar(measurements: Measurement[]): Measurement[] {
  return [...measurements].sort(
    (a, b) =>
      ORDEM_PLANO.indexOf(a.plane) - ORDEM_PLANO.indexOf(b.plane) || a.slice - b.slice || a.id - b.id,
  );
}

/** Uma linha do relatorio, antes de virar texto ou CSV. */
interface Linha {
  id: number;
  kind: "distance" | "angle";
  plane: Plane;
  slice: number;
  /** Valor numerico cru: quem vai consumir o CSV nao quer "5,00 mm" na celula. */
  valor: number;
  unidade: "mm" | "deg";
  /** Como o clinico le: com unidade e casas. */
  valorFormatado: string;
  huA: number;
  huB: number;
  huC: number | null;
  deltaHu: number | null;
}

function paraLinha(m: Measurement): Linha {
  const comum = { id: m.id, kind: m.kind, plane: m.plane, slice: m.slice, huA: m.huA, huB: m.huB };
  return m.kind === "angle"
    ? { ...comum, valor: m.angleDeg, unidade: "deg", valorFormatado: formatDeg(m.angleDeg), huC: m.huC, deltaHu: null }
    : { ...comum, valor: m.distanceMm, unidade: "mm", valorFormatado: formatMm(m.distanceMm), huC: null, deltaHu: m.deltaHu };
}

/**
 * CSV com TODA celula entre aspas, inclusive as numericas.
 *
 * Entre aspas as duas duvidas somem de uma vez: o separador deixa de poder
 * aparecer dentro de um valor e a virgula decimal deixa de brigar com o
 * delimitador. Um `toFixed` solto num CSV e o jeito classico de o Excel
 * abrir o arquivo com as colunas trocadas em um numero so.
 *
 * O separador e virgula e o decimal e ponto, como em `formatMm`. Um CSV
 * brasileiro de Excel usa ponto e virgula, mas o resto do aplicativo formata
 * com ponto -- misturar os dois no mesmo produto seria pior do que escolher
 * um. Quem precisar abrir em pt-BR troca o delimitador na importacao.
 */
function celula(valor: string | number | null): string {
  const texto = valor === null ? "" : String(valor);
  return `"${texto.replaceAll('"', '""')}"`;
}

function linhaCsv(l: Linha): string {
  return [
    l.id,
    l.kind,
    l.plane,
    l.slice,
    l.valor,
    l.unidade,
    l.huA,
    l.huB,
    l.huC,
    l.deltaHu,
  ]
    .map(celula)
    .join(",");
}

const CABECALHO_CSV = [
  "id", "tipo", "plano", "corte", "valor", "unidade", "hu_a", "hu_b", "hu_c", "delta_hu",
];

/**
 * Preenche a direita ate `largura`, com um espaco de separacao.
 *
 * O espaco esta no fim de proposito: ele e o que garante uma coluna vazia de
 * pelo menos um espaco, senao a coluna seguinte gruda na anterior e o relatorio
 * vira "distanciaAxial 1" -- ilegivel, e sem nenhum sinal de erro.
 */
function coluna(texto: string, largura: number): string {
  return colunaBruta(texto, largura) + " ";
}

function colunaBruta(texto: string, largura: number): string {
  return texto + " ".repeat(Math.max(0, largura - texto.length));
}

/**
 * Monta o relatorio em texto e CSV a partir das medicoes confirmadas.
 *
 * Nao le o volume: os numeros ja vem prontos na medicao (mm e graus). Se o
 * relatorio precisasse do volume, ele teria de lembrar de qual corte cada
 * medicao veio -- e essa e exatamente a informacao que o `slice` ja carrega.
 */
export function buildReport(measurements: Measurement[], meta: ReportMeta | null): Report {
  const linhas = ordenar(measurements).map(paraLinha);
  const voxel = meta ? meta.voxelSize.map((v) => v.toFixed(2)).join(" x ") + " mm" : "-";

  const cabecalho = [
    "MEDICOES ODONTOVISION",
    `Paciente: ${meta?.patientName ?? "-"}`,
    `Exame: ${meta?.patientId ?? "-"}`,
    `Data: ${meta?.studyDate ?? "-"}`,
    `Serie: ${meta?.seriesDescription ?? "-"}`,
    `Modalidade: ${meta?.modality ?? "-"}`,
    `Voxel: ${voxel}`,
    `Total: ${linhas.length}`,
  ];

  const texto: string[] = [...cabecalho, ""];
  const csv: string[] = [CABECALHO_CSV.map(celula).join(",")];

  if (linhas.length === 0) {
    texto.push("Nenhuma medicao registrada.");
  } else {
    // Larguras pelo conteudo, nao fixas: um id de tres digitos ou um "151.9"
    // desalinharia a coluna e o relatorio pareceria quebrado.
    const tipo = (l: Linha) => (l.kind === "angle" ? "angulo" : "distancia");
    const dens = (l: Linha) =>
      l.kind === "angle"
        ? `${l.huA} -> ${l.huB} -> ${l.huC} HU`
        : `${l.huA} -> ${l.huB} HU   Δ${formatDeltaHu(l.deltaHu ?? 0)}`;

    const larguras = {
      id: Math.max("#".length, ...linhas.map((l) => String(l.id).length)),
      tipo: Math.max("TIPO".length, ...linhas.map((l) => tipo(l).length)),
      plano: Math.max("PLANO".length, ...linhas.map((l) => PLANO_LABEL[l.plane].length)),
      corte: Math.max("CORTE".length, ...linhas.map((l) => String(l.slice).length)),
      valor: Math.max("RESULTADO".length, ...linhas.map((l) => l.valorFormatado.length)),
    };

    const linha = (a: string, b: string, c: string, d: string, e: string, f: string) =>
      `${coluna(a, larguras.id)}${coluna(b, larguras.tipo)}${coluna(c, larguras.plano)}` +
      `${coluna(d, larguras.corte)}${coluna(e, larguras.valor)}${f}`.trimEnd();

    texto.push(
      linha("#", "TIPO", "PLANO", "CORTE", "RESULTADO", "DENSIDADE (HU)"),
    );
    for (const l of linhas) {
      texto.push(
        linha(String(l.id), tipo(l), PLANO_LABEL[l.plane], String(l.slice), l.valorFormatado, dens(l)),
      );
    }
  }

  for (const l of linhas) csv.push(linhaCsv(l));

  // \n e nao \r\n: o E2E compara a string, e um CR invisivel no fim de cada
  // linha faria o arquivo parecer igual no editor e diferente no teste.
  return { texto: `${texto.join("\n")}\n`, csv: `${csv.join("\n")}\n`, contagem: linhas.length };
}
