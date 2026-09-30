import type { Measurement } from "./measure.ts";
import type { Annotation } from "./annotate.ts";
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
  /** Quantas medidas e quantas anotacoes entraram. */
  contagem: { medicoes: number; anotacoes: number };
}

/** Ordem de apresentacao: axial, coronal, sagital, e dentro deles o corte. */
const ORDEM_PLANO: Plane[] = ["axial", "coronal", "sagittal"];

type Local = { plane: Plane; slice: number; id: number };

function ordenar<T extends Local>(itens: T[]): T[] {
  return [...itens].sort(
    (a, b) =>
      ORDEM_PLANO.indexOf(a.plane) - ORDEM_PLANO.indexOf(b.plane) || a.slice - b.slice || a.id - b.id,
  );
}

/**
 * Uma linha do relatorio, seja de medida ou de anotacao.
 *
 * Os dois tipos dividem a MESMA linha em vez de ter linhas separadas: o CSV
 * e uma tabela so, e quem importa em planilha ou em script quer uma tabela.
 * As colunas que nao se aplicam ao tipo ficam vazias, nunca com um valor
 * inventado -- um `valor` de 0 numa anotacao seria mentira.
 */
interface Linha {
  id: number;
  kind: "distance" | "angle" | "anotacao";
  plane: Plane;
  slice: number;
  /** Valor numerico cru: quem vai consumir o CSV nao quer "5,00 mm" na celula. */
  valor: number | null;
  unidade: "mm" | "deg" | null;
  /** Como o clinico le: com unidade e casas. Vazio na anotacao. */
  valorFormatado: string;
  huA: number | null;
  huB: number | null;
  huC: number | null;
  deltaHu: number | null;
  texto: string | null;
  u: number | null;
  v: number | null;
}

const ROTULO_TIPO: Record<Linha["kind"], string> = {
  distance: "distancia",
  angle: "angulo",
  anotacao: "anotacao",
};

function paraMedida(m: Measurement): Linha {
  const base = {
    id: m.id, kind: m.kind, plane: m.plane, slice: m.slice, valorFormatado: "",
    texto: null, u: null, v: null,
  };
  return m.kind === "angle"
    ? { ...base, valor: m.angleDeg, unidade: "deg", valorFormatado: formatDeg(m.angleDeg),
        huA: m.huA, huB: m.huB, huC: m.huC, deltaHu: null }
    : { ...base, valor: m.distanceMm, unidade: "mm", valorFormatado: formatMm(m.distanceMm),
        huA: m.huA, huB: m.huB, huC: null, deltaHu: m.deltaHu };
}

function paraAnotacao(a: Annotation): Linha {
  return {
    id: a.id, kind: "anotacao", plane: a.plane, slice: a.slice,
    valor: null, unidade: null, valorFormatado: "",
    huA: null, huB: null, huC: null, deltaHu: null,
    texto: a.text, u: a.u, v: a.v,
  };
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
    l.id, ROTULO_TIPO[l.kind], l.plane, l.slice, l.valor, l.unidade,
    l.huA, l.huB, l.huC, l.deltaHu, l.texto, l.u, l.v,
  ]
    .map(celula)
    .join(",");
}

/**
 * `u` e `v` so existem para anotacao, e `valor`/`hu_*` so para medidas. Nenhuma
 * linha perde informacao por isso: a geometria de uma medida esta no valor e
 * nas pontas, e a de uma anotacao esta no ponto. Uma coluna vazia e melhor
 * que uma coluna com o valor da outra coisa.
 */
const CABECALHO_CSV = [
  "id", "tipo", "plano", "corte", "valor", "unidade",
  "hu_a", "hu_b", "hu_c", "delta_hu", "texto", "u", "v",
];

/**
 * Preenche a direita ate `largura`, com um espaco de separacao.
 *
 * O espaco esta no fim de proposito: ele e o que garante uma coluna vazia de
 * pelo menos um espaco, senao a coluna seguinte gruda na anterior e o relatorio
 * vira "distanciaAxial 1" -- ilegivel, e sem nenhum sinal de erro.
 */
function coluna(texto: string, largura: number): string {
  return texto + " ".repeat(Math.max(0, largura - texto.length)) + " ";
}

/**
 * Monta o relatorio em texto e CSV a partir das medidas e anotacoes.
 *
 * Nao le o volume: os numeros ja vem prontos na medicao (mm e graus) e o
 * ponto ja vem na anotacao. Se o relatorio precisasse do volume, ele teria de
 * lembrar de qual corte cada registro veio -- e essa e exatamente a
 * informacao que `slice` ja carrega.
 *
 * Medidas e anotacoes aparecem no relatorio INTEIRO, nao so as do corte na
 * tela: trocar de corte esconde a regua para nao poluir a imagem, mas apagar
 * do arquivo uma medicao que o clinico acabou de fazer seria perder trabalho.
 */
export function buildReport(
  measurements: Measurement[],
  annotations: Annotation[],
  meta: ReportMeta | null,
): Report {
  const linhas = [
    ...ordenar(measurements).map(paraMedida),
    ...ordenar(annotations).map(paraAnotacao),
  ];
  const medidas = linhas.filter((l) => l.kind !== "anotacao");
  const anotacoes = linhas.filter((l) => l.kind === "anotacao");

  const voxel = meta ? meta.voxelSize.map((v) => v.toFixed(2)).join(" x ") + " mm" : "-";

  const texto: string[] = [
    "RELATORIO ODONTOVISION",
    `Paciente: ${meta?.patientName ?? "-"}`,
    `Exame: ${meta?.patientId ?? "-"}`,
    `Data: ${meta?.studyDate ?? "-"}`,
    `Serie: ${meta?.seriesDescription ?? "-"}`,
    `Modalidade: ${meta?.modality ?? "-"}`,
    `Voxel: ${voxel}`,
    `Medicoes: ${medidas.length}`,
    `Anotacoes: ${anotacoes.length}`,
    "",
  ];

  const csv: string[] = [CABECALHO_CSV.map(celula).join(",")];

  if (medidas.length === 0) {
    texto.push("Nenhuma medicao registrada.");
  } else {
    // Larguras pelo conteudo, nao fixas: um id de tres digitos ou um "151.9"
    // desalinharia a coluna e o relatorio pareceria quebrado.
    const dens = (l: Linha) =>
      l.kind === "angle"
        ? `${l.huA} -> ${l.huB} -> ${l.huC} HU`
        : `${l.huA} -> ${l.huB} HU   Δ${formatDeltaHu(l.deltaHu ?? 0)}`;

    const larguras = {
      id: Math.max(1, ...medidas.map((l) => String(l.id).length)),
      tipo: Math.max(4, ...medidas.map((l) => ROTULO_TIPO[l.kind].length)),
      plano: Math.max(5, ...medidas.map((l) => PLANO_LABEL[l.plane].length)),
      corte: Math.max(5, ...medidas.map((l) => String(l.slice).length)),
      valor: Math.max(9, ...medidas.map((l) => l.valorFormatado.length)),
    };

    const linha = (a: string, b: string, c: string, d: string, e: string, f: string) =>
      `${coluna(a, larguras.id)}${coluna(b, larguras.tipo)}${coluna(c, larguras.plano)}` +
      `${coluna(d, larguras.corte)}${coluna(e, larguras.valor)}${f}`.trimEnd();

    texto.push(linha("#", "TIPO", "PLANO", "CORTE", "RESULTADO", "DENSIDADE (HU)"));
    for (const l of medidas) {
      texto.push(
        linha(String(l.id), ROTULO_TIPO[l.kind], PLANO_LABEL[l.plane], String(l.slice), l.valorFormatado, dens(l)),
      );
    }
  }

  if (anotacoes.length > 0) {
    texto.push("", "ANOTACOES");
    // O ponto entra em (u,v): e ele que diz ONDE o rotulo esta, e sem ele o
    // arquivo exportado nao deixa o clinico reencontrar a anotacao.
    const larguras = {
      id: Math.max(1, ...anotacoes.map((l) => String(l.id).length)),
      plano: Math.max(5, ...anotacoes.map((l) => PLANO_LABEL[l.plane].length)),
      corte: Math.max(5, ...anotacoes.map((l) => String(l.slice).length)),
      ponto: Math.max(9, ...anotacoes.map((l) => `(${l.u},${l.v})`.length)),
    };
    const linha = (a: string, b: string, c: string, d: string, e: string) =>
      `${coluna(a, larguras.id)}${coluna(b, larguras.plano)}${coluna(c, larguras.corte)}` +
      `${coluna(d, larguras.ponto)}${e}`.trimEnd();

    texto.push(linha("#", "PLANO", "CORTE", "PONTE", "ROTULO"));
    for (const l of anotacoes) {
      texto.push(
        linha(String(l.id), PLANO_LABEL[l.plane], String(l.slice), `(${l.u},${l.v})`, l.texto ?? ""),
      );
    }
  }

  for (const l of linhas) csv.push(linhaCsv(l));

  // \n e nao \r\n: o E2E compara a string, e um CR invisivel no fim de cada
  // linha faria o arquivo parecer igual no editor e diferente no teste.
  return {
    texto: `${texto.join("\n")}\n`,
    csv: `${csv.join("\n")}\n`,
    contagem: { medicoes: medidas.length, anotacoes: anotacoes.length },
  };
}
