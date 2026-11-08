# Roadmap de implementação — OdontoVision

**Backlog:** [OdontoVision no Linear](https://linear.app/secretaria-claudia/project/odontovision-visualizador-cbctdicom-909f9097ddb2). Este documento registra a sequência técnica; o status de execução de cada item pertence ao Linear.

## Fase 1 — Base consolidada (primeiro marco)

| Ordem | Entrega | Evidência para aprovação |
|---|---|---|
| 1.1 | Recuperar a base e preservar o histórico | Git limpo, scripts executáveis, projeto em pasta própria |
| 1.2 | Validar a aplicação | `npm run verify` e percurso E2E com phantom sintético |
| 1.3 | Auditoria DICOM e geométrica | Testes de série, anisotropia, RLE, JPEG, HU, régua e ângulo |
| 1.4 | Auditoria de visualização 3D e desempenho | MIP com limiar e proporção física; limites CPU documentados |
| 1.5 | Produto e governança | PRD, arquitetura, validação clínica, issues e rotina multiagente |

**Marco concluído quando:** aplicação funciona localmente com fixtures, evidência de todos os checks, sem alegar suporte a formatos que falham.

## Fase 2 — Renderização e compatibilidade

Sequência: (a) decoder JPEG 2000 com testes e tratamento de erro; (b) 3D WebGL2/WebGPU com fallback e benchmark em volume representativo; (c) salvamento/restauração local de sessão com hash do volume e testes de recuperação; (d) acessibilidade e UX para estudos grandes.

**Critérios:** formatos testados com referências independentes, 3D visualmente e geometricamente equivalente ao CPU, nenhuma rede com dados do exame, importação de sessão rejeitada caso não corresponda ao volume.

## Fase 3 — Segmentação e STL

Sequência: editor de máscara por corte → sobreposição MPR/3D → isolamentos/transparência → geração STL em coordenadas físicas → avaliação de modelo de IA em base consentida e representativa.

**Critérios:** máscaras editáveis, superfície conferida em mm, revisão humana obrigatória para qualquer modelo; resultados por categoria de estrutura e protocolo, com taxa de falhas documentada.

## Fase 4 — Ferramentas clínicas

Definir casos de uso separados com usuários clínicos: inclusões dentárias, relações radiculares, avaliação óssea, comunicação com pacientes e planejamento de procedimentos. Só implementar interpretação assistida depois de definição de uso pretendido, risco, validação clínica e análise do enquadramento regulatório.

**Critérios:** fluxos clínicos aprovados, documentação de limitações e controles do usuário; nenhum diagnóstico autônomo.

## Política de execução

- Priorizar fase 1 e somente liberar outra fase quando seus critérios forem atendidos.
- Uma issue pequena por comportamento verificável, com implementação e revisão independentes.
- Medidas clínicas e alterações de decoder exigem comparação numérica e regressão, além de testes de interface.
- PRs bloqueados se houver alteração não intencional de geometria, dados privados ou compatibilidade DICOM.
- Sem deadlines estimados até medir desempenho real dos agentes e disponibilidade das ferramentas.
