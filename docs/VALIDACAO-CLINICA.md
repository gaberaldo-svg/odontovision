# Validação clínica, segurança e privacidade — OdontoVision

**Situação inicial:** ferramenta de visualização e investigação técnica. A existência de um visualizador funcional **não demonstra validação para diagnóstico**. Não divulgar indicações clínicas nem acurácia sem evidências e avaliação regulatória correspondente.

## Matriz de riscos prioritários

| Risco | Efeito | Verificação mínima | Bloqueador de uso clínico? |
|---|---|---|---|
| Pixel spacing, slice spacing ou orientação incorretos | Medida errada sem erro visual | Phantom anisotrópico + casos com orientação variável + comparação independente | Sim |
| Série com cortes trocados/misturados | Anatomia deformada | Série fora de ordem, cortes duplicados e espessura heterogênea | Sim |
| DICOM comprimido decodificado indevidamente | Intensidades e anatomia falsas | Fixtures para cada transfer syntax; roundtrip pixel a pixel quando lossless | Sim |
| JPEG com perda e HU aproximado | Leitura de intensidade enganosa | Indicar compressão; não prometer densidade óssea quantitativa | Sim, para uso quantitativo |
| Intensidade em CBCT exibida como HU universal | Interpretação clínica inadequada | Documentar dependência de fabricante/protocolo/calibração | Sim, para inferência de densidade |
| MIP tratado como segmentação | Estruturas sobrepostas confundem interpretação | Rotular como MIP e não permitir confundir com superfície isolada | Sim |
| DICOM com identificação pessoal enviado ao exterior | Violação de privacidade | Inspeção de rede e artefatos, revisão de logs, controle de acesso | Sim |
| Modelo de IA com falsos achados | Decisão clínica incorreta | Dados representativos, métricas por achado, revisão humana | Sim |

## Plano de verificação técnica (fase 1)

1. **Fixtures sintéticas:** geometria 3D com spacing assimétrico e medidas conhecidas; HU/rescale com intercept/slope variados.
2. **Transfer Syntax:** Explicit/Implicit VR, big endian, RLE, JPEG suportado; testar falha explícita para JPEG 2000/JPEG-LS/JPEG Lossless até implementação.
3. **MPR:** validar ordem e orientação com marcadores sintéticos reconhecíveis nos três planos; conferir crosshair.
4. **Régua e ângulo:** comparar distância e ângulo com resultado independente em mm, incluindo 0°, 90°, 180° e vértices inválidos.
5. **3D:** conferir relação de aspecto, limiar e geometria ortográfica, documentando que MIP não fornece superfície segmentada.
6. **E2E:** fazer percurso do usuário com phantom, anotações e exportação, sem dados pessoais.
7. **Privacidade:** monitorar requisições durante importação e interação; inspecionar Git e outputs para ausência de arquivos com dados identificáveis.

## Validação com exames clínicos

Só utilizar exames **desidentificados de forma verificada**, com base legal/autorização definida e sem upload para ambientes ou agentes externos. Preparar protocolo de amostragem por equipamento, FOV, voxel, transfer syntax e fabricante. Comparar medidas e marcos anatômicos com software de referência e pelo menos um avaliador clínico qualificado. Registrar erros, intervalos de confiança, limitações e casos excluídos. Determinar tolerâncias de aceitação antes de ver resultados, por uso pretendido.

## Requisitos para IA e uso comercial

Antes de interpretação assistida por IA, estabelecer o uso pretendido, risco clínico, dataset validado, sensibilidade/especificidade por classe, métricas de segmentação, estratificação por protocolo, vigilância de falhas, revisão humana e estratégia de atualização do modelo. Avaliar LGPD, segurança da informação e enquadramento como software médico junto às normas vigentes da Anvisa e orientação especializada, conforme o uso pretendido.

## Critérios de liberação

**Liberação técnica de demonstração:** phantom, DICOM compatível, testes automatizados e limites claros. **Liberação para apoio clínico:** relatório técnico-clínico assinado por responsáveis, riscos residuais aceitos, medidas validadas por protocolo e avaliação regulatória. **IA diagnóstica:** fase distinta, nunca presumida por um resultado visual convincente.
