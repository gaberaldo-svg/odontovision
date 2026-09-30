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
- **Fase 3** (estamos aqui): canvas axial 2D com HU e W/L reais.
  MPR coronal/sagittal fica **fora** até existir carga de série multi-slice —
  um único `.dcm` de 1 frame não tem dado para os planos ortogonais.
- **Fase 4**: carga de diretório/ série, MPR e medição em mm.

Só avance de fase com ordem explícita do usuário.

## Comandos

```bash
npm run dev            # servidor de desenvolvimento
npm run build          # build de produção
npm run sample         # gera a fixture sintética em samples/
npm run verify:sample  # valida a fixture (27 checks)
npm run verify:volume  # valida HU/W-L/canvas puros (40 checks)
npm run e2e            # Chrome headless via CDP, porta 3210
npm run verify         # tsc + build + sample + volume + e2e
```

Não existe `npm run lint`. O E2E roda com viewport 1600x1000 porque o headless
default (800x600) fica abaixo do breakpoint `lg`, onde a sidebar — e o
`[data-hu]` — ficam ocultos.

## Ignorar sempre

`node_modules/`, `.next/`, `dist/`, e qualquer `*.dcm` / `*.zip`.
Exames de teste vão em `samples/` e NUNCA devem ser lidos pelo agente —
ele só recebe contagem de arquivos, nunca o conteúdo binário.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
