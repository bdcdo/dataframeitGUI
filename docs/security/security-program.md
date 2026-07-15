# Programa de segurança do dataframeitGUI

**Status:** proposta de governança associada à [epic #45](https://github.com/bdcdo/dataframeitGUI/issues/45).

## Finalidade e fonte de verdade

Este documento define como o dataframeitGUI recebe, classifica, transforma e encerra trabalho de segurança. Ele é estável por desenho: não reproduz a lista de issues, o estado das frentes nem a ordem corrente do backlog. A [epic #45](https://github.com/bdcdo/dataframeitGUI/issues/45) é a fonte canônica desses dados mutáveis e deve apontar para cada item acionável.

A epic coordena o programa; não substitui as issues de execução. Toda vulnerabilidade, auditoria delimitada, decisão operacional ou hardening que exija trabalho próprio deve ter uma issue separada, com escopo, responsável, evidência e critério de encerramento verificáveis.

O programa cobre o frontend Next.js, o backend FastAPI, Supabase/Postgres e suas políticas RLS, Clerk, integrações de LLM, dependências, segredos, deploys e rotinas administrativas. Qualidade geral só entra neste fluxo quando afeta uma fronteira de confiança, confidencialidade, integridade, disponibilidade ou rastreabilidade de segurança.

## Governança e ownership

| Papel | Responsabilidade | Condição de saída |
| --- | --- | --- |
| Owner do programa | Manter a #45 como índice canônico, conduzir a cadência, arbitrar severidade e cobrar pendências sem owner. | Nenhum achado fica sem classificação, responsável e próximo passo. |
| Owner do achado | Delimitar causa raiz, superfície afetada, impacto, reprodução e critério de correção na subissue. | A issue está pronta para implementação sem depender de contexto oral. |
| Owner da correção | Implementar em worktree e PR próprios, adicionar testes proporcionais ao risco e registrar riscos residuais. | O PR referencia a subissue e contém evidência suficiente para revisão. |
| Validador | Reproduzir o problema antes da correção quando seguro, revisar a fronteira de autorização e executar a validação pós-fix. | O resultado é registrado como aprovado, reprovado ou bloqueado, com artefatos. |
| Operador de release | Aplicar mudanças operacionais autorizadas, observar rollout e executar rollback quando necessário. | O estado aplicado e a verificação posterior estão documentados. |

Uma pessoa pode acumular papéis quando a equipe não comportar separação completa, mas correções críticas ou altas não podem depender apenas da afirmação de quem as implementou. Nesses casos, a validação deve incluir revisão independente por outra pessoa ou agente e evidência reproduzível que o owner do programa consiga inspecionar.

O owner do programa atribui owner nominal a cada subissue, registrado no campo `Assignees` da própria issue — essa é a fonte canônica do ownership. Menções genéricas à equipe não contam como ownership; uma subissue sem assignee volta à triagem na revisão semanal. A #45 mantém somente estado, dependências e links, sem copiar o nome do responsável.

## Cadência

| Ritual | Frequência ou prazo | Saída mínima |
| --- | --- | --- |
| Intake | Contínuo; todo relato novo recebe triagem inicial em até 1 dia útil. | Confirmação do escopo, proteção de dados do relato e severidade provisória. |
| Revisão do backlog | Semanal. | Prioridade, owner, bloqueios e próximo passo atualizados na #45. |
| Auditoria focal | Mensal, alternando as fronteiras com maior risco ou mudança recente. | Escopo versionado, inventário contado e findings convertidos em subissues. |
| Revisão de dependências e segredos | Semanal por automação e na revisão de cada PR. | Alertas classificados; nenhum segredo aparece em evidência ou diff. |
| Revisão do programa | Trimestral. | Cobertura das auditorias, riscos aceitos, itens sem movimento e critério de encerramento da epic revistos. |
| Revisão extraordinária | Após incidente, mudança de autenticação, nova integração externa, alteração ampla de RLS ou exposição de endpoint. | Threat model atualizado e auditoria focal antes ou imediatamente após o rollout, conforme o risco. |

A cadência organiza a descoberta, mas não posterga contenção. Um achado crítico ou alto segue os prazos da prioridade correspondente assim que confirmado.

## Severidade

Severidade mede o pior impacto plausível nas condições verificadas; esforço, conveniência de agenda e existência de um fix simples não a reduzem. A classificação registra separadamente impacto, alcance, pré-condições, detectabilidade e confiança da evidência.

| Severidade | Critério | Exemplos orientadores |
| --- | --- | --- |
| Crítica | Comprometimento amplo e reproduzível sem privilégio prévio relevante, ou perda de controle sobre produção. | Execução remota não autenticada, bypass completo de autenticação, segredo de produção explorável ou exfiltração em massa. |
| Alta | Violação relevante de confidencialidade ou integridade entre usuários/projetos, escalação de privilégio ou indisponibilidade séria com pré-condições realistas. | IDOR cross-project, escrita administrativa por pesquisador, exposição de claims ou dados sensíveis a usuário indevido. |
| Média | Impacto limitado por escopo, papel ou sequência menos provável, sem comprometimento amplo; inclui lacuna de defesa em profundidade com caminho concreto. | Policy permissiva sob condição restrita, validação incompleta de payload autenticado, ausência de guard que amplia dano de outro erro. |
| Baixa | Hardening sem exploração demonstrada, exposição de baixa sensibilidade ou melhoria de observabilidade e processo. | Header defensivo ausente, redução de informação de debug sem acesso indevido comprovado, documentação de operação segura. |

Quando a evidência não permite escolher entre duas severidades, registra-se a maior como provisória e abre-se uma tarefa curta de verificação. A severidade só muda com nova evidência anexada à issue; a justificativa anterior permanece no histórico.

## Prioridade e alvos de resposta

Prioridade define ordem e prazo operacional. Ela parte da severidade e pode subir por exploração ativa, exposição pública, volume afetado, ausência de mitigação, mudança prestes a ser publicada ou dependência que bloqueia outras correções. Dependência técnica pode alterar a sequência, mas não rebaixa a severidade.

| Prioridade | Regra padrão | Alvo de resposta |
| --- | --- | --- |
| P0 | Crítica confirmada, incidente ativo ou segredo de produção exposto. | Conter em até 4 horas; abrir proposta de correção em até 1 dia útil; manter acompanhamento diário até validação. |
| P1 | Alta confirmada ou média com exploração pública/alcance ampliado. | Definir owner e plano em até 2 dias úteis; submeter proposta de correção em até 5 dias úteis. |
| P2 | Média sem exploração ativa ou hardening que fecha uma cadeia concreta. | Planejar no ciclo mensal e iniciar em até 30 dias corridos. |
| P3 | Baixa, melhoria preventiva ou risco aceito com compensação suficiente. | Revisar trimestralmente e executar quando a fronteira relacionada for tocada. |

Os alvos são objetivos de resposta do programa, não autorização para deploy apressado. Se uma correção segura exigir mais tempo, o owner registra a mitigação temporária, o bloqueio concreto e a próxima data de decisão.

## Evidência mínima

Toda conclusão deve ser auditável por alguém que não participou da descoberta. A issue ou o artefato vinculado registra, no mínimo: data e autor da verificação; commit, migration ou versão observada; ambiente e papel usados; ativo e fronteira de confiança; pré-condições; passos exatos; resultado esperado e observado; quantidade exata de objetos, endpoints ou policies no escopo; severidade e prioridade justificadas; artefatos sanitizados; e critério objetivo de correção.

Uma auditoria também registra a consulta, ferramenta e versão utilizadas, o universo enumerado, itens examinados, itens excluídos com motivo e contagens reconciliáveis. “Nenhum problema encontrado” sem inventário e método não é evidência de cobertura.

Uma correção também registra o teste que falhava antes e passa depois, a explicação da causa raiz, a fronteira de autorização exercitada, o comportamento de master/service role quando aplicável, migrations e rollback quando houver, além de qualquer risco residual. Teste mockado não substitui teste de RLS, trigger, autenticação ou integração quando o comportamento depende do runtime real.

Uma mudança operacional também registra estado anterior, comando ou ação autorizada, estado posterior, observação do rollout e procedimento de reversão. Tokens, cookies, JWTs completos, chaves, e-mails reais e dados de projeto não entram em screenshots, logs ou comentários; a evidência deve usar identificadores descartáveis ou valores redigidos.

## Fluxo auditoria → subissue → fix → validação

1. **Delimitar a auditoria.** O owner fixa commit, ambiente, componentes, consultas e universo esperado antes de interpretar resultados.
2. **Registrar o finding.** Cada causa raiz acionável vira subissue vinculada à #45. Findings que compartilham apenas sintoma não devem ser agrupados; ocorrências com a mesma causa e o mesmo contrato podem permanecer juntas se a correção e a validação forem únicas.
3. **Classificar.** O owner do programa confirma severidade, prioridade, responsável, dependências e necessidade de contenção. Duplicatas apontam para uma única issue canônica; não mantêm dois planos paralelos.
4. **Propor a correção.** A implementação nasce do default branch atualizado em worktree própria. O PR trata uma subissue ou um conjunto inseparável explicitamente justificado e usa `Closes #N`, `Fixes #N` ou `Resolves #N` em inglês no corpo.
5. **Revisar adversarialmente.** A revisão verifica causa raiz, caminhos alternativos, identidade direta e delegada, mudança de escopo, RLS/service role, estado anterior e posterior, rollback e qualidade dos testes, conforme a fronteira afetada.
6. **Validar.** O validador executa o critério definido na subissue e preenche resultado e evidência. Falha de ambiente é “bloqueado”, não “aprovado”; leitura de código é distinta de validação funcional.
7. **Encerrar a subissue.** O item só fecha após a mudança aplicável estar incorporada ou a decisão de risco estar formalizada e após a evidência pós-correção atender ao critério. Risco residual vira nova subissue quando exige trabalho próprio.
8. **Atualizar a epic.** A #45 recebe somente o estado, dependência, ordem e link para a evidência canônica; detalhes técnicos permanecem na subissue e no PR para evitar duplicação e drift.

## Aceitação temporária de risco

Aceitar risco exige decisão explícita do owner do programa, motivo, alcance, severidade preservada, controle compensatório, responsável e data de expiração. A validade máxima é de 90 dias; ao vencer, a decisão precisa ser renovada com nova evidência ou a correção volta à prioridade correspondente.

`wontfix`, custo alto ou ausência de exploração conhecida não constituem aceitação por si sós. Um finding sem correção e sem aceite válido permanece aberto na fonte canônica.

## Encerramento da epic

A #45 pode ser encerrada quando: todas as issues abertas com impacto de segurança foram classificadas ou vinculadas; não resta finding crítico ou alto sem correção validada ou aceite de risco vigente; auditorias em curso converteram seus gaps em subissues; mudanças operacionais pendentes têm fonte própria e owner; a evidência de encerramento aponta para os artefatos canônicos; e não há trabalho de coordenação exclusivo que ainda precise da epic.

Se restar apenas 1 subissue pendente e a epic não tiver coordenação própria, a #45 deve ser fechada com comentário curto e essa subissue permanece aberta como fonte da pendência. Se surgir depois uma nova frente que exija coordenação conjunta, reabre-se a epic ou cria-se uma nova, conforme o recorte temporal e técnico.

O comentário final registra a data, o resultado de cada critério acima por referência, riscos aceitos ainda vigentes e onde o programa continuará sendo acompanhado. Ele não copia a lista histórica de filhas: os links e o timeline da #45 preservam esse histórico.
