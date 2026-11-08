# PRD — OdontoVision

**Versão:** 1.0 · **Data:** 2026-11-08 · **Estado:** aprovado para execução incremental

**Produto:** visualizador odontológico CBCT/DICOM, inicialmente para uso local no navegador.

**Código de origem:** https://github.com/gaberaldo-svg/odontovision
**Backlog oficial:** https://linear.app/secretaria-claudia/project/odontovision-visualizador-cbctdicom-909f9097ddb2

## 1. Problema, objetivo e público

Cirurgiões-dentistas precisam consultar tomografias, orientar-se nos três planos, examinar estruturas em 3D e registrar medições sem depender, em todo atendimento, de um programa específico do fabricante do tomógrafo. O OdontoVision pretende oferecer uma experiência clara, auditável e local para **exploração visual e documentação de imagens**.

**Usuários principais:** cirurgiões-dentistas, inicialmente com foco em Ortodontia e avaliação maxilofacial. **Usuários secundários:** equipes clínicas autorizadas que demonstram imagens ao paciente e revisores de qualidade da ferramenta. A decisão diagnóstica e a interpretação permanecem com o profissional habilitado.

**Resultado do MVP de consolidação:** abrir dados DICOM suportados, navegar nos planos axial/coronal/sagital, explorar MIP 3D, medir, anotar, exportar relatório e obter uma linha de base de testes reproduzível.

## 2. Princípios e fronteiras

1. **Local-first:** exames são lidos e processados no dispositivo, sem backend, conta, telemetria, upload ou compartilhamento automático. O navegador deve funcionar mesmo sem conexão após os recursos serem carregados.
2. **Precisão mensurável:** preservar tamanho físico do voxel, orientação e ordem de fatias; recusar formatos não suportados com informação explícita.
3. **Transparência:** identificar limitações de compressão, MIP e informações de intensidade. Valores apresentados como HU em CBCT dependem da calibração e podem não corresponder a HU de tomografia médica convencional.
4. **Assistência clínica:** nenhuma inferência, classificação de doença ou sugestão terapêutica automática será tratada como diagnóstico validado no MVP.
5. **Não confundir modalidades:** radiografias panorâmicas e periapicais 2D não contêm uma reconstrução anatômica 3D verdadeira; esse recurso depende de volume CBCT ou de uma estimativa explicitamente identificada.

## 3. Requisitos funcionais e aceitação

| ID | Requisito | Aceite verificável | Fase |
|---|---|---|---|
| RF-01 | Importação de arquivo `.dcm`, série e multiframe suportados | Importação local; mensagens claras para arquivo inválido ou sintaxe não suportada | 1 |
| RF-02 | Preservar metadados geométricos e intensidade | Cortes reproduzem ordenação, spacing, rescale e orientação suportada; casos de teste com anisotropia | 1 |
| RF-03 | Três planos MPR sincronizados | Cursor/crosshair e índices corretos nos planos axial, coronal e sagital | 1 |
| RF-04 | Janela/nível, zoom e navegação | Ações alteram somente a visualização, sem modificar os valores do volume | 1 |
| RF-05 | Visualizador 3D por MIP | Rotação, zoom, limiar e proporção física correta; indicado como MIP, não segmentação | 1 |
| RF-06 | Régua, ângulo e anotação | Distâncias em mm e ângulos em graus; persistência das anotações durante a sessão | 1 |
| RF-07 | Relatório | Exporta medições/anotações em texto/CSV sem transmitir dados | 1 |
| RF-08 | Compatibilidade DICOM expandida | JPEG 2000 com decodificação verificada; regressões por transfer syntax | 2 |
| RF-09 | Visualização 3D acelerada | Caminho GPU com fallback e teste em volumes maiores; sem alterar geometria | 2 |
| RF-10 | Salvar/restaurar sessão | Exportação/importação local de medições, notas e estado; associação inequívoca ao exame | 2 |
| RF-11 | Segmentação manual por regiões | Edição/isolamento de máscara; sobreposição em MPR e 3D | 3 |
| RF-12 | Exportação de malha STL | Malha gerada da máscara na escala física correta, com testes de superfície | 3 |
| RF-13 | Segmentação assistida por IA | Modelo avaliado por estrutura, scanner e protocolo; revisão/edição obrigatória | 3 |
| RF-14 | Ferramentas ortodônticas e de planejamento | Requisitos clínicos específicos aprovados e protocolos de verificação separados | 4 |

### Fluxos essenciais do MVP

**Exame de demonstração:** abrir aplicativo → selecionar exame sintético → navegar por MPR → abrir 3D → medir → adicionar nota → exportar relatório. Deve funcionar sem dados pessoais.

**Exame local:** selecionar DICOM do computador → verificar compatibilidade e características da série → visualizar e medir → exportar relatório. Nenhum dado deve deixar o dispositivo.

**Erro de compatibilidade:** arquivo inválido/incompleto/comprimido de maneira não suportada → mostrar mensagem de motivo e instruir a utilizar exportação DICOM compatível; não inventar imagem ou reescalonar medidas silenciosamente.

## 4. Requisitos não funcionais

| ID | Obrigação | Verificação |
|---|---|---|
| RNF-01 | Privacidade local | Inspeção de rede e código; ausência de envio de exame, PID e metadados a servidores |
| RNF-02 | Regulação e LGPD | Avaliar classificação regulatória e bases legais antes de operação clínica/serviços online |
| RNF-03 | Robustez | Não congelar UI silenciosamente; apresentar progresso/erro em estudos pesados |
| RNF-04 | Qualidade geométrica | Fixtures anisotrópicas, orientação, séries fora de ordem e medições com tolerância definida |
| RNF-05 | Testabilidade | `npm run verify` e testes E2E executáveis; regressões para bugs já corrigidos |
| RNF-06 | Acessibilidade | Interface navegável, textos legíveis, feedback de foco e atalhos documentados |
| RNF-07 | Compatibilidade | Chrome/Edge desktop atuais, prioridade Windows; outros navegadores após validação |
| RNF-08 | Rastreabilidade | Cada alteração vinculada a uma issue e PR, com evidência de teste e revisão |

Não há meta rígida de FPS antes de estabelecer hardware e conjunto de exames de referência. Na fase 2, estabelecer orçamento de memória e FPS com volumes CBCT representativos e resultado de baseline arquivado.

## 5. O que já existe e o que falta

O repositório existente documenta: Next.js/React/TypeScript, parsing DICOM, leitura não comprimida e RLE, JPEG 8-bit via navegador, MPR, medidas, notas, relatório e MIP 3D CPU. Esses recursos precisam de **revalidação na cópia atual** antes de serem anunciados como aprovados. Faltam JPEG 2000, renderização GPU, persistência da sessão e segmentação. Os limites conhecidos do README são a fonte de verdade até testes posteriores.

**Fora da primeira entrega:** PACS/cloud, autenticação, armazenamento de pacientes, IA diagnóstica, prescrição, integração com prontuário, laudos automáticos e disponibilização comercial.

## 6. Entregáveis, critérios de pronto e métricas

**D0 — Consolidação:** repositório em pasta própria, PRD e arquitetura, backlog Linear, aplicação iniciável, fluxo sintético verificado, suites existentes executadas e limitações explicitadas.

**Definition of Done por issue:** implementação em branch/worktree isolado; testes relacionados passam; reviewer inspeciona diffs; não há paciente real versionado; descrição do PR contém cenário, evidência e limitações; Linear atualizado com link do PR/commit.

**Métricas operacionais:** taxa de aprovação do `npm run verify`, compatibilidade por transfer syntax, tempo de carregamento/rotação por volume, erro geométrico por fixture, defeitos clínicos bloqueadores e percentual de issues com evidência de QA. Essas métricas são coletadas no ambiente de teste, sem telemetria de pacientes.

## 7. Riscos, dependências e decisões

- **Risco clínico:** medidas plausíveis porém incorretas por voxel spacing, orientação, compressão ou interpolação. Mitigar com fixtures e comparação com referência em casos anonimizados.
- **Risco de privacidade:** identificação inadvertida em DICOM, arquivos de suporte, screenshots, logs ou commits. Mitigar com exemplos sintéticos, revisão de assets e bloqueio de uploads.
- **Risco de desempenho:** MIP CPU em CBCT grande. Mitigar na fase 2 com GPU, limites de memória e feedback de processamento.
- **Risco de compatibilidade:** variabilidade de séries DICOM e transfer syntax, especialmente JPEG 2000. Registrar e testar por fabricante/protocolo antes de prometer compatibilidade ampla.
- **Dependências:** Node.js 22, npm, Git, navegador com APIs necessárias, conjunto sintético de testes; Orca e Linear para orquestração, OpenCode e Antigravity conforme capacidades verificadas.

**Decisões:** continuar no repositório `odontovision`; manter processamento local; usar Linear como backlog e GitHub como histórico de código; usar Codex como integrador. IA diagnóstica só depois de validação e avaliação regulatória.
