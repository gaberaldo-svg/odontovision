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
- **Fase 5a** (estamos aqui): HU das duas pontas da régua e ΔHU com sinal.
  Ainda não existe medição de ângulo, anotação de texto nem exportação.

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
- **O canvas é quadrado; o que sobra é tarja.** O `aspect-square` do viewport
  resolve, e `imagemDoPlano` no `scripts/e2e-dicom.mjs` centraliza a imagem
  dentro dele. Nada de medir posição por fração da altura: converta
  coordenada de voxel em pixel pelo centro do voxel (`u + 0.5`).
- **Plano ortogonal só existe com `slices >= 2`.** Um `.dcm` de 1 frame não tem
  eixo Z; a UI explica em vez de mostrar imagem vazia.
- `Sagital` é o nome da viewport; `"sagittal"` é o valor interno de `Plane`.

## Comandos

```bash
npm run dev              # servidor de desenvolvimento
npm run build            # build de produção
npm run sample           # gera a fixture de 1 corte em samples/
npm run sample:series    # gera a série de 32 cortes + a variante multiframe
npm run verify:sample    # valida a fixture de 1 corte (27 checks)
npm run verify:volume    # valida HU/W-L/MPR/medicao puros (110 checks)
npm run verify:series    # monta a série real e confere voxel a voxel (50 checks)
npm run e2e              # Chrome headless via CDP, porta 3210
npm run verify           # tsc + build + sample + volume + series + e2e
```

Não existe `npm run lint`. O E2E roda com viewport 1600x1000 porque o headless
default (800x600) fica abaixo do breakpoint `lg`, onde a sidebar — e o
`[data-hu]` — ficam ocultos. As fixtures em `samples/` são gitignored e
regeneráveis.

## Ignorar sempre

`node_modules/`, `.next/`, `dist/`, e qualquer `*.dcm` / `*.zip`.
Exames de teste vão em `samples/` e NUNCA devem ser lidos pelo agente —
ele só recebe contagem de arquivos, nunca o conteúdo binário.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
