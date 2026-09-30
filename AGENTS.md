# Onde mexer

Este é o **OdontoVision** — visualizador web de tomografia odontológica/maxilofacial
(CBCT / DICOM) que roda 100% no navegador (client-side).

## Regra de ouro do projeto

**Fase 1 = casca visual e design system. Nenhuma lógica DICOM real.**

Enquanto `src/` não tiver os componentes de UI, NÃO implemente:
parsing DICOM, HU, presets numéricos de W/L, canvas/WebGL,
Cornerstone3D, medição em mm. Tudo mockado.

Contexto é o recurso mais escasso. Pedir tudo de uma vez é o que quebra loops.

## Fases

- **Fase 1** (estamos aqui): layout dark + todos os componentes de UI com
  dado mockado. Sliders, presets e botões existem e reagem visualmente,
  mas não tocam em imagem real.
- **Fase 2**: ler UM arquivo `.dcm` local, extrair tags no console.
- **Fase 3**: conectar canvas, HU, W/L, MPR.

Só avance de fase com ordem explícita do usuário.

## Comandos

```bash
npm run dev      # servidor de desenvolvimento
npm run build    # build de produção
npm run lint     # lint
npm run verify   # lint + build + smoke
```

## Ignorar sempre

`node_modules/`, `.next/`, `dist/`, e qualquer `*.dcm` / `*.zip`.
Exames de teste vão em `samples/` e NUNCA devem ser lidos pelo agente —
ele só recebe contagem de arquivos, nunca o conteúdo binário.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
