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

## Fases

- **Fase 1**: casca visual e design system, tudo com dado mockado.
- **Fase 2**: ler UM arquivo `.dcm` local e extrair tags no console.
- **Fase 3**: canvas axial 2D com HU e W/L reais.
- **Fase 4a** (estamos aqui): carga de série multi-arquivo/multi-frame, volume
  3D achatado `[z][y][x]` e MPR axial/coronal/sagittal com crosshair
  sincronizado.
- **Fase 4b**: medição de distância em mm. Ainda não existe.

Só avance de fase com ordem explícita do usuário.

## Armadilhas do MPR

Estas custaram bug real; todas já têm teste.

- **O aspecto do eixo vertical tem uma fonte só: `planeAspect(volume, plane)`.**
  No axial vale 1 (o eixo v é uma linha da imagem); em coronal/sagittal vale
  `zAspect` = `sliceSpacing / pixelSpacing[1]`. O `scale` do canvas vem de
  `max(columns, rows * aspect)`: se o cálculo do `scale` e o do render usarem
  aspectos diferentes, a imagem encolhe (o axial já saiu com ¼ do tamanho)
  sem nenhum erro visível.
- **O viewport não é quadrado.** O grid estica a altura e o `aspect-square`
  perde para o stretch, então a imagem fica centrada com tarja preta. Nada de
  medir posição por fração da altura do canvas: converta coordenada de voxel
  em pixel com `imagemDoPlano` no `scripts/e2e-dicom.mjs`.
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
npm run verify:volume    # valida HU/W-L/MPR puros (74 checks)
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
