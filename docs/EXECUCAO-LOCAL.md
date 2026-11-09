# Executar e verificar o OdontoVision no Windows

## Iniciar a aplicação

1. Abrir `INICIAR-ODONTOVISION.cmd` na pasta do projeto ou abrir um terminal nela e executar `npm run dev`.
2. Visitar `http://localhost:3000` no navegador.
3. Clicar em **Exemplo** para trabalhar com um phantom sintetico, ou importar arquivos DICOM autorizados do disco local.

Requer Node.js 22 ou superior e as dependencias de `package-lock.json`. Se `node_modules` nao estiver presente, executar `npm ci` em um terminal com acesso ao registro npm.

**Privacidade:** os exames sao processados no navegador. Para depurar, nao anexar imagens ou metadados de pacientes a issues, commits, prints ou plataformas externas. O ambiente atual e um prototipo de visualizacao; nao ha validacao clinica/regulatoria para emissao de diagnosticos.

## Comandos de verificacao

```powershell
npm run build
npm run sample
npm run sample:series
npm run verify:sample
npm run verify:volume
npm run verify:series
npm run e2e
```

`npm run verify` combina todos os passos acima, incluindo TypeScript. O modo de desenvolvimento e o build usam Webpack porque a compilacao Turbopack depende de subprocessos de CSS que falharam no ambiente de teste com restricoes. O E2E inicia um servidor local na porta 3210 e o Chrome/Edge na porta 9222; se essas portas estiverem ocupadas, encerrar o programa que as utiliza antes do teste. A automacao `.github/workflows/verify.yml` executa o mesmo roteiro em pull requests no GitHub Actions (Windows).

Os scripts geram arquivos DICOM **sinteticos** em `samples/`, que sao ignorados pelo Git. JPEG 2000 ainda nao esta implementado. O teste com imagem JPEG real externa e opcional e ignorado quando a amostra nao estiver disponivel; a decodificacao de JPEG de 8 bits tem teste gerado no browser.

## Trabalhar com os agentes

- Linear: [projeto OdontoVision](https://linear.app/secretaria-claudia/project/odontovision-visualizador-cbctdicom-909f9097ddb2) e tarefas SEC-12 a SEC-22.
- GitHub: `gaberaldo-svg/odontovision`, com revisao de alteracoes em PR.
- Orca: abrir o runtime, registrar este diretorio como repositorio e criar uma worktree por tarefa. Confirmar disponibilidade com `orca status --json` antes de delegar.
- OpenCode, Codex, Antigravity e Maestri: seguir o contrato de tarefas e os limites de automacao em `docs/ORQUESTRACAO.md`.

Nao iniciar agentes nao supervisionados sobre estudos DICOM ou componentes de calculo geometrico ate validar o fluxo de worktrees, isolamento e revisao.
