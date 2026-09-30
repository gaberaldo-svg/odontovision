# Onde mexer

Este é o **OdontoVision** — visualizador web de tomografia odontológica/maxilofacial
(CBCT / DICOM) que roda 100% no navegador (client-side).

## Regra de ouro do projeto

**O processing é 100% client-side. Nada de upload, nada de backend.**

A UI usa **Base UI** (`@base-ui/react`), não Radix. Duas diferenças que já
causaram bug: componentes usam `render` no lugar de `asChild`, e
`Menu.Item` dispara `onClick` — `onSelect` (idiomático do Radix) é ignorado
em silêncio. `DropdownMenuLabel` mapeia para `Menu.GroupLabel` e **exige** um
`DropdownMenuGroup` pai; sem ele o popup lança e o React desmonta a árvore
inteira.

Contexto é o recurso mais escasso. Pedir tudo de uma vez é o que quebra loops.

## Teste sem framework

Não há Vitest/Jest. Cada `scripts/verify-*.mjs` é um script Node que importa o
`.ts` da lib **com type-stripping** e roda no topo do arquivo (`await import`).
Isso impõe duas regras em `lib/`:

- import **de valor** precisa da extensão (`from "./volume.ts"`, como já em
  `parse.ts` e `worker.ts`). Sem ela o Node não resolve o módulo e o script
  morre antes do primeiro check; import **de tipo** pode ficar sem extensão,
  porque é apagado na compilação;
- nada de `enum` nem `namespace`: type-stripping não remove enum.

## Fases

- **Fase 1**: casca visual e design system, tudo com dado mockado.
- **Fase 2**: ler UM arquivo `.dcm` local e extrair tags no console.
- **Fase 3**: canvas axial 2D com HU e W/L reais.
- **Fase 4a**: carga de série multi-arquivo/multi-frame, volume 3D achatado
  `[z][y][x]` e MPR axial/coronal/sagittal com crosshair sincronizado.
- **Fase 4b**: régua de distância em mm por plano, com lista, remoção e limpeza.
- **Fase 5a**: HU das duas pontas da régua e ΔHU com sinal.
- **Fase 5b**: ângulo de três pontos (dois cliques marcam as pontas, o terceiro
  fecha), em graus e com o HU dos três pontos.
- **Fase 5c** (estamos aqui): relatório das medições em texto e CSV, com
  download e cópia. Ainda não existe anotação de texto.

Só avance de fase com ordem explícita do usuário.

## Armadilhas do MPR

Estas custaram bug real; todas já têm teste.

- **O aspecto do eixo vertical tem uma fonte só: `planeAspect(volume, plane)`.**
  No axial vale 1 (o eixo v é uma linha da imagem); em coronal/sagittal vale
  `zAspect` = `sliceSpacing / pixelSpacing[1]`. O `scale` do canvas vem de
  `max(columns, rows * aspect)`: se o cálculo do `scale` e o do render usarem
  aspectos diferentes, a imagem encolhe (o axial já saiu com ¼ do tamanho)
  sem nenhum erro visível.
- **A medida em mm tem a mesma pegadinha, agora na conta.** O eixo v do
  coronal e do sagittal é z, que vale `sliceSpacing` — não `pixelSpacing`.
  Usar `pixelSpacing` nos dois eixos mede 4× curto (1,00 mm contra 0,25 mm na
  fixture), e o sintoma é o mesmo: erro 4× sem nenhum erro na tela. Use
  `planeVoxelSizeMm`/`planeDistanceMm`, nunca `pixelSpacing` direto.
- **A régua é do plano E do corte onde foi desenhada** (`data-rulers` no
  viewport conta quantas estão visíveis). Medir não projeta para os outros
  planos: um viewer de PACS mostra as réguas nos MPRs, aqui elas somem, e o
  E2E compara desenhadas × lista no corte atual.
- **O HU da ponta tem que sair de `planeHuAt`, o mesmo caminho do readout sob o
  cursor.** Ler o HU de outro lugar (o `storedValue` cru, ou no rescale errado)
  faz a régua discordar do número que o usuário acabou de ver passando o mouse
  no ponto — e o delta erra junto, porque é a diferença dos dois. O HU é lido no
  `slice` da própria medida, não no corte que estiver em foco.
- **O ângulo é calculado em mm, não em voxel.** No coronal/sagital a grade é
  anisotrópica (0,25 mm em u contra 1,00 mm em v na fixture), e a mesma tripla
  de voxels dá 90,0° no axial e 151,9° no coronal. Calcular com a distância
  entre voxels reproduz o número do axial em todo plano — um valor plausível e
  errado, que só aparece quando alguém compara com o software do fabricante.
  Use `planeAngleDeg`, que já converte com `planeVoxelSizeMm`.
- **`atan2(cruzamento, produto)`, nunca `acos`.** Em ângulo reto o produto
  arredonda para um valor acima da norma dos vetores, e o `acos` devolve `NaN`
  justamente no caso mais comum. A 90,0° exata é onde o `acos` quebra.
- **O ângulo não tem `deltaHu`.** Com três pontos não existe par único: a
  densidade dos três vai para a lista e o delta fica de fora, porque um delta
  escolhido por conta própria seria um número que ninguém pediu.
- Vértice em cima de uma das pontas é recusado (`vertice-igual`), porque o
  ângulo não existe com um braço de tamanho zero. Três pontos **colineares**, ao
  contrário, são válidos: 0° e 180° é assim que se confere se algo está reto.
- `Measurement` é união discriminada por `kind: "distance" | "angle"`.
  Qualquer consumidor novo narrow por `kind` antes de ler `distanceMm` ou
  `angleDeg`; o E2E usa `data-measure-kind` para isso.
- **O relatório lista o exame inteiro; a lista lateral é do corte.** São
  filtros diferentes de propósito: trocar de corte esconde a régua para não
  poluir a imagem, mas apagar do relatório uma medição que o clínico acabou de
  fazer seria perder trabalho. Se um dia o relatório passar a filtrar por
  plano/corte, ele vai contradizer a tela e o dental vai exportar menos do que
  mediu.
- **Toda célula do CSV vai entre aspas, inclusive as numéricas.** Entre aspas a
  vírgula deixa de poder aparecer dentro de um valor e a vírgula decimal deixa
  de brigar com o delimitador. Solto, um `toFixed` é a forma clássica de o
  Excel abrir o arquivo com as colunas trocadas. Separador vírgula e decimal
  ponto, como em `formatMm` — misturar os dois no mesmo produto seria pior.
- **`PLANO_LABEL` mora em `lib/format.ts`, não na sidebar.** O relatório
  precisa do mesmo rótulo da lista; dois mapas desse tipo divergem, e o
  relatório passa a discordar da lista ao lado dele.
- O CSV não é atributo de DOM: o botão monta um Blob. O unit test garante o
  CSV byte a byte e o E2E garante o texto renderizado — não há como ler o
  arquivo baixado de dentro da página, e fingir que há seria o teste-mentira.
- **O canvas é quadrado; o que sobra é tarja.** O `aspect-square` do viewport
  resolve, e `imagemDoPlano` no `scripts/e2e-dicom.mjs` centraliza a imagem
  dentro dele. Nada de medir posição por fração da altura: converta
  coordenada de voxel em pixel pelo centro do voxel (`u + 0.5`).
- **Plano ortogonal só existe com `slices >= 2`.** Um `.dcm` de 1 frame não tem
  eixo Z; a UI explica em vez de mostrar imagem vazia.
- **O pixel data big endian existe e é uma única sintaxe.** `1.2.840.10008.1.2.2`
  (Explicit VR Big Endian) é a única com bytes big endian; Implicit VR é sempre
  little endian. Ler ao contrário **não dá erro nenhum** — o HU sai plausível e
  errado, que é a classe de bug mais perigosa deste projeto. Achado com um
  arquivo real (`MR_small_bigendian.dcm`): 905 virava −30461, porque `0x0389`
  lido ao contrário é `0x8903`. O `verify:sample` fabrica o gêmeo big endian da
  própria fixture e compara **voxel a voxel**, justamente porque um check de
  "o valor não é NaN" passaria com os bytes trocados.
- **O que a biblioteca não sabe ler não pode vazar o nome dela.** O
  dicom-parser lança `TypeError: i.copy is not a function` para Deflate, e o
  `parseDicom` traduz para uma mensagem que nomeia o arquivo e sugere
  corrompido/comprimido, deixando o detalhe no fim para quem for reportar.
- **Nem todo `.dcm` é imagem.** Um objeto SEG de 1 bit (exemplo real:
  `liver_1frame.dcm`) recusa com `BitsAllocated 1`, e isso está certo.
- `Sagital` é o nome da viewport; `"sagittal"` é o valor interno de `Plane`.

## Comandos

```bash
npm run dev              # servidor de desenvolvimento
npm run build            # build de produção
npm run sample           # gera a fixture de 1 corte em samples/
npm run sample:series    # gera a série de 32 cortes + a variante multiframe
npm run fetch:real       # baixa DICOMs REAIS de teste em samples/real/ (ver abaixo)
npm run verify:sample    # valida a fixture de 1 corte (38 checks)
npm run verify:volume    # valida HU/W-L/MPR/medicao/angulo/relatorio puros (155 checks)
npm run verify:series    # monta a série real e confere voxel a voxel (50 checks)
npm run e2e              # Chrome headless via CDP, porta 3210
npm run verify           # tsc + build + sample + volume + series + e2e
```

Não existe `npm run lint`. O E2E roda com viewport 1600x1000 porque o headless
default (800x600) fica abaixo do breakpoint `lg`, onde a sidebar — e o
`[data-hu]` — ficam ocultos. As fixtures em `samples/` são gitignored e
regeneráveis.

## Arquivos DICOM reais

`npm run fetch:real` baixa sete `.dcm` reais em `samples/real/`, vindos de
`pydicom/data/test_files` — arquivos de teste de terceiros, sintéticos ou
publicamente desidentificados, **nunca exames de paciente**. O `README.md`
gerado junto lista, para cada arquivo, o que ele comprova.

São eles que cobrem o que as fixtures synthéticas não alcançam: anatomia de
verdade, Explicit VR Big Endian, Deflate, JPEG 2000 e um objeto SEG (que não
vira volume). Dois bugs só apareceram com eles — o big endian lido ao
contra e a mensagem minificada da biblioteca. Nada de `verify` depende do
download: o `verify:sample` **fabrica** o gêmeo big endian da própria fixture,
então a cobertura roda em qualquer máquina, offline.

## Ignorar sempre

`node_modules/`, `.next/`, `dist/`, e qualquer `*.dcm` / `*.zip`.
Arquivos de teste vão em `samples/` e NUNCA devem ser lidos pelo agente — ele só
recebe contagem de arquivos e metadados do header, nunca o conteúdo binário.
`samples/real/` é a exceção conhecida: são fixtures públicas sem paciente, e o
agente pode ler header e HU para validar o parser.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
