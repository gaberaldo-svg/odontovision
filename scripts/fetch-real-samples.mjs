/**
 * Baixa arquivos DICOM REAIS e publicos para `samples/real/`.
 *
 * Sao arquivos de teste de terceiros (projeto pydicom), nao exames de paciente:
 * syntheticos ou/publicamente desidentificados, e o proposito e exercitar
 * caminhos que as fixtures proprias nao alcancam. Ver o README do pydicom em
 * `src/pydicom/data/test_files/README.txt` para a procedencia de cada um.
 *
 * Uso: npm run fetch:real
 *
 * `samples/` e gitignored, entao o download nao entra no repositorio. O que
 * entra e este script -- e a lista de arquivos com o que cada um comprova.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = join(HERE, "..", "samples", "real");
const BASE =
  "https://raw.githubusercontent.com/pydicom/pydicom/main/src/pydicom/data/test_files";

/**
 * O que cada arquivo comprova. `espera` e o resultado que o app deve dar --
 * e o que o `verify-real` le para conferir, se um dia existir.
 */
const ARQUIVOS = [
  {
    nome: "CT_small.dcm",
    espera: "CT real 128x128, Explicit VR LE, nao comprimido: vira volume",
    porque: "o caminho feliz com anatomia de verdade e rescale negativo (-1024)",
  },
  {
    nome: "MR_small.dcm",
    espera: "MR real 64x64, vira volume",
    porque: "mesma imagem que o big endian abaixo, para comparar voxel a voxel",
  },
  {
    nome: "MR_small_bigendian.dcm",
    espera: "MESMA imagem de MR_small, em Explicit VR BE: vira volume identico",
    porque:
      "o pixel data big endian e lido ao contrario, sem erro nenhum. " +
      "Encontrado aqui: 905 virava -30461 e a tela ficava plausivel e errada",
  },
  {
    nome: "ExplVR_BigEnd.dcm",
    espera: "CT big endian sem o resto da sintaxe: recusado, sem volume",
    porque: "big endian e big endian; nem todo arquivo dele e carregavel",
  },
  {
    nome: "image_dfl.dcm",
    espera: "Deflate: erro LEGIVEL, sem o nome minificado da biblioteca",
    porque:
      "dicom-parser lanca `TypeError: i.copy is not a function` aqui. " +
      "O nome interno nao pode chegar na tela do usuario",
  },
  {
    nome: "JPEG2000.dcm",
    espera: "JPEG 2000: needsDecompression, sem volume",
    porque: "o aviso de 'sintaxe comprimida' precisa vir de um arquivo real",
  },
  {
    nome: "MR_small_RLE.dcm",
    espera: "MR real em RLE Lossless: MESMA imagem de MR_small, vira volume identico",
    porque:
      "e o gemelo comprimido de MR_small.dcm. Decodificar os dois e comparar " +
      "voxel a voxel e a prova de que o decoder RLE esta certo -- e o mesmo " +
      "truque do gêmeo big endian, agora com um codec no meio",
  },
  {
    nome: "liver_1frame.dcm",
    espera: "OBJETO SEG de 1 bit: recusado, sem volume",
    porque: "nem todo .dcm e imagem -- segmentacao nao vira volume de HU",
  },
];

mkdirSync(DEST, { recursive: true });

let baixados = 0;
let falharam = 0;

for (const { nome, espera, porque } of ARQUIVOS) {
  const destino = join(DEST, nome);
  if (existsSync(destino)) {
    console.log(`  ja existe  ${nome.padEnd(28)} ${statSync(destino).size} bytes`);
    continue;
  }
  try {
    const resposta = await fetch(`${BASE}/${nome}`);
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const bytes = new Uint8Array(await resposta.arrayBuffer());
    writeFileSync(destino, bytes);
    console.log(`  baixado    ${nome.padEnd(28)} ${bytes.length} bytes`);
    baixados++;
  } catch (erro) {
    console.log(`  FALHOU     ${nome.padEnd(28)} ${erro.message ?? erro}`);
    falharam++;
  }
}

// O README fica junto dos arquivos: daqui a seis meses ninguem lembra por que
// estes e nao outros, e o endereco do pydicom pode ter mudado de branch.
const linhas = [
  "# samples/real",
  "",
  "Arquivos DICOM de terceiros, baixados por `npm run fetch:real`.",
  "Nao sao exames de paciente: vem de `pydicom/data/test_files`, que sao",
  "sinteticos ou publicamente desidentificados.",
  "",
  ...ARQUIVOS.flatMap((a) => [`## ${a.nome}`, `- espera: ${a.espera}`, `- porque: ${a.porque}`, ""]),
  "Nao edite nada aqui: e cache de download, e `gitignored`.",
  "",
];
writeFileSync(join(DEST, "README.md"), linhas.join("\n"));

console.log(`\n${baixados} baixados, ${falharam} falharam, em samples/real/`);
process.exit(falharam > 0 ? 1 : 0);
