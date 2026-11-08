# Arquitetura técnica — OdontoVision

## Estado de referência

Aplicação Next.js 16 / React 19 / TypeScript, com estado Zustand e componentes Base UI. A leitura DICOM e os algoritmos de imagem estão em `lib/dicom/`, independentes de React, e são testáveis com Node. Os componentes `components/viewer/` exibem 2D/MPR e MIP 3D; `components/layout/` fornece importação e interface. `store/` contém estado de sessão.

```text
Arquivo(s) DICOM escolhido(s) pelo usuário
       │ File API (somente navegador)
       ▼
lib/dicom: parse, series, jpeg/rle, volume, measure, annotate, report
       │
       ├─ Volume com voxels + dimensões + spacing + rescale
       ├─ MPR axial/coronal/sagital
       ├─ Medições e anotações locais
       └─ MIP 3D (CPU, estágio atual)
       │
       ▼
store/use-viewer-store.ts
       │
       ▼
components/layout + components/viewer → Canvas/UI → relatório local
```

## Contratos e salvaguardas

- **Entrada:** arquivos `.dcm`/séries escolhidos explicitamente. Validar cabeçalho DICOM, quantidade de frames, transfer syntax, geometria, Pixel Data e consistência entre fatias. Não transmitir bytes nem dados identificáveis.
- **Volume:** respeitar `columns`, `rows`, `slices`, `pixelSpacing`, `sliceSpacing`, `rescaleSlope`, `rescaleIntercept` e ordem correta. Transformações devem preservar unidades físicas.
- **Medidas:** obter distância por `planeVoxelSizeMm`/`planeDistanceMm`, ângulo em espaço físico e intensidade do caminho canônico `planeHuAt`; nunca inferir mm pela dimensão de tela.
- **Imagem 3D:** MIP calcula projeção ortográfica com limiar de intensidade. **Não equivale a superfície segmentada** e não separa individualmente dentes, canal ou nervos.
- **Transfer syntax atual:** Explicit/Implicit VR não comprimido, big endian, RLE e JPEG compatível com navegador; JPEG 2000, JPEG-LS e JPEG Lossless ainda pendentes. Explicitar erros sem aproximação silenciosa.
- **Privacidade:** sem endpoints de exame, banco remoto, analytics ou mecanismo de upload. Exames reais não devem entrar em `public/`, fixtures, Git ou ferramentas de agentes.
- **Erros:** falhar com mensagem indicando arquivo, condição e capacidade suportada; bloquear medições quando não houver geometria confiável.

## Componentes futuros

**JPEG 2000:** decoder compatível no browser com fixtures de 12/16 bits, testes por transfer syntax e comparações sem perdas. Seleção de biblioteca só após verificação de licença, bundle e desempenho.

**GPU:** renderer WebGL2 inicialmente (compatibilidade), com capacidade detectada e fallback CPU; usar identidade geométrica e cores/unidades consistentes com MPR. Medir tempo e memória em CBCT representativo.

**Persistência:** exportação de um arquivo local de sessão, contendo versão de schema, hash dos metadados/volume, anotações, medições e câmera. Importar só com exame correspondente; se incompatível, oferecer inspeção sem aplicar coordenadas.

**Segmentação:** máscaras voxelizadas independentes da intensidade e da renderização, edição manual com undo/redo, renderização combinada e extração de malha em mm. Qualquer modelo de IA roda localmente ou terá arquitetura separada sujeita a nova aprovação de privacidade.

## Ferramentas e integração

- **Código:** GitHub `gaberaldo-svg/odontovision`, branches por issue, PR e CI.
- **Gestão:** Linear com requisitos e evidências; o nome da branch segue a issue.
- **Distribuição:** Orca como coordenador técnico; agentes em worktrees isolados sempre que possível.
- **Execução:** Codex integra e verifica; OpenCode e Antigravity assumem tarefas específicas após testes de lançamento/conectividade.
- **Visibilidade:** Maestri como quadro de agentes quando conexão funcional for comprovada; não depende dele para liberar commits ou PRs.

## Decisões de arquitetura

Manter stack e módulos existentes na fase 1. Nenhum servidor DICOM, PACS ou API remota será adicionado agora. A ampliação para persistência, GPU, segmentação ou IA exige testes de regressão e issue própria.
