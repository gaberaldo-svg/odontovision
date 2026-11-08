# Manual de operação multiagente — OdontoVision

**Fontes de verdade:** Linear para status e responsáveis; GitHub para histórico e código; `docs/PRD.md` para escopo e aceite. Maestri é uma visão auxiliar e Orca distribui trabalho quando disponível.

## Papéis e capacidades

| Participante | Papel | Condição para uso |
|---|---|---|
| Usuário | Product Owner, priorização, aceite clínico | Valida demonstração e critérios clínicos |
| Linear | Backlog e acompanhamento | Projeto OdontoVision cadastrado |
| Orca | Coordenar, despachar e acompanhar DAG | CLI + runtime ativos e worktree selecionada |
| Codex | Arquitetura, integração, revisão e testes | Acesso ao checkout de integração |
| OpenCode | Implementar issues delimitadas | CLI instalado, sessão e modelo configurados |
| Antigravity | UI, prototipação e refinamento | IDE disponível; automação confirmada antes de despachar |
| Maestri | Visão espacial dos agentes/notas | CLI/terminal conectado e workspace configurado |
| GitHub | Repositório e PRs | Repositório vinculado e conectividade autenticada |

Instalação de um aplicativo **não comprova integração ativa**. Não marcar tarefa como delegada sem recibo de criação de agente/terminal e acesso real ao workspace.

## Contrato de tarefa

Toda issue deve registrar: objetivo observável, entrada e arquivos permitidos, responsável único, dependências, critérios de aceite, comandos de teste, risco clínico/privacidade e referência de branch/PR. O coordenador escolhe tarefas independentes e as executa em paralelo; não permite dois agentes gravando no mesmo checkout ou editando os mesmos módulos.

**Estados sugeridos:** Backlog → Todo → In Progress → In Review → Done. Bloqueios devem informar motivo, responsável pela resolução e próximo experimento; o estado no Linear prevalece.

**Nomes:** `feature/SEC-XX-descricao`, `fix/SEC-XX-descricao`, `docs/SEC-XX-descricao`. Uma branch por issue; revisão e merge após testes e autorização apropriada. Os exemplos `SEC-XX` precisam ser substituídos pelos identificadores reais das issues.

## Procedimento operacional

1. Confirmar issue, critérios de aceite e código-base `master`; conferir se há mudanças locais antes de iniciar.
2. No Orca, verificar o runtime (`orca status --json`) e ler sua própria versão do manual (`orca skills get orchestration`). Criar sessão de coordenação somente se runtime acessível; não presumir que iniciar o aplicativo já criou agentes.
3. Criar worktree/branch por tarefa. Encaminhar ao Codex, OpenCode ou agente disponível, com limites dos arquivos e testes esperados. Antigravity recebe design quando houver ligação verificável.
4. Registrar no Linear quem recebeu, o identificador da execução e a branch. O agente devolve resumo, caminhos alterados, verificações executadas e riscos.
5. Codex integra: compara diff com PRD, testa DICOM/medidas/3D, verifica privacidade e revisa regressões.
6. Abrir PR, anexar evidências de teste, relacionar issue e solicitar revisão. Apenas após revisão e merge registrar Done.
7. Refletir os resultados no Maestri, se conectado; se indisponível, manter Linear atualizado, sem bloquear o ciclo.

## Primeiro teste de integração entre agentes

**Tarefa experimental:** documentação de uma melhoria de UI sobre um phantom sintético, sem acesso a exames reais. O coordenador deve criar issue e worktree; um agente entrega commit; outro revisa; CI executa verificações; o resultado e links ficam no Linear. Medir tempo gasto e qualidade antes de escalar para várias tarefas clínicas em paralelo.

## Falhas e retomada

- **Orca indisponível:** registrar estado, executar sequencialmente no checkout de desenvolvimento e não alegar orquestração ativa.
- **Maestri sem CLI conectado:** usar Linear para status e GitHub para revisão; tentar conexão em atividade própria.
- **Antigravity sem automação:** usar manualmente para interface; encaminhar a implementação pelo agente com CLI validado.
- **Erro de rede ou autenticação Git:** preservar commits locais, não inventar link de PR. Tentar sincronizar quando acesso estiver comprovado.
- **Conflito de branch:** integrar em série com revisão, nunca sobrescrever alterações do outro agente.
- **Dados de pacientes:** impedir compartilhamento externo; utilizar exclusivamente DICOM sintético ou desidentificado com autorização apropriada.

## Regras para prompts de agentes

O prompt de cada execução deve mencionar: issue, fase do PRD, limites de arquivos, branch, comando de verificação, cuidado com geometria DICOM, proibição de upload de exames, saída esperada (diff, checks e bloqueios). O supervisor não deve declarar sucesso apenas pela saída do terminal: confirmar mudança em Git, testes e estado da issue.
