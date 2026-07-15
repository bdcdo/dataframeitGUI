# Protocolo e evidências de validação manual

| Campo | Valor |
| --- | --- |
| Feature | `002-preregister-members` |
| Issue | [#183](https://github.com/bdcdo/dataframeitGUI/issues/183) |
| Status | Protocolo preparado; execução não iniciada. |

## Relação com o quickstart

O procedimento funcional continua definido em [`quickstart.md`](./quickstart.md). Este arquivo não substitui nem reescreve seus passos: ele identifica cenários, fixa pré-condições, registra o resultado observado e define a evidência necessária para decidir as tarefas T014, T028 e T031 de [`tasks.md`](./tasks.md).

Se o quickstart mudar, a execução usa a versão do mesmo commit registrada no cabeçalho da rodada. Divergências entre o procedimento e esta matriz devem ser resolvidas antes do teste, sem completar lacunas por suposição.

## Identificação da rodada

Cada execução recebe um `run_id` no formato `183-AAAAMMDD-HHMM-<sha7>`. Uma nova tentativa após correção ou bloqueio recebe outro `run_id`; não se sobrescrevem resultados anteriores.

| Campo | Valor da rodada |
| --- | --- |
| `run_id` | — |
| Executor | — |
| Revisor da evidência | — |
| Início e fim em America/Sao_Paulo | — |
| Commit completo e branch | — |
| URL base do frontend | — |
| Ambiente Supabase e project ref | — |
| Ambiente Clerk e instance type | — |
| Navegador e versão | — |
| Migrations aplicadas | — |
| Autorização para usar o ambiente | — |

A rodada só começa após confirmar que Clerk e Supabase são ambientes de desenvolvimento ou teste autorizados. Produção, projetos de pesquisa reais e contas pessoais estão fora do protocolo.

## Fixtures descartáveis

São usadas exatamente 5 identidades Clerk descartáveis e 2 projetos descartáveis. Os e-mails devem seguir o mecanismo de teste aceito pelo tenant, sem reutilizar contas pessoais. Senhas, códigos, cookies, JWTs e chaves não são registrados neste documento.

| ID | Estado inicial | Finalidade | Clerk user ID | Profile UUID | E-mail de teste |
| --- | --- | --- | --- | --- | --- |
| ACC-COORD | conta ativa | Coordenar os 2 projetos e executar mutações administrativas. | — | — | — |
| ACC-PENDING | sem conta no início | Exercitar pré-registro, ativação e posterior origem de unificação. | — | — | — |
| ACC-CANONICAL | conta ativa | Identidade canônica com participação nos 2 projetos. | — | — | — |
| ACC-ALIAS | sem conta no início | Exercitar vínculo pendente, signup e acesso como identidade canônica. | — | — | — |
| ACC-OUTSIDER | conta ativa | Provar isolamento RLS e depois exercer o fluxo legado de membro existente. | — | — | — |

Além das 5 identidades, a rodada usa 1 e-mail sintético que nunca será ativado para o cenário de remoção de pendente. Esse endereço cria apenas um placeholder e deve constar no inventário de cleanup.

| ID | Finalidade | Project UUID | Nome visível |
| --- | --- | --- | --- |
| PRJ-MAIN | Todos os fluxos US1, US2, RLS e regressão. | — | — |
| PRJ-ISOLATION | Provar que ACC-ALIAS não herda outro projeto de ACC-CANONICAL e exercitar aviso de correção em múltiplos projetos. | — | — |

PRJ-MAIN e PRJ-ISOLATION não podem usar `E2E_PROJECT_ID` nem `E2E_LOTTERY_PROJECT_ID`. Antes da execução, registre os 2 IDs reservados e confirme textualmente que não coincidem com os IDs da rodada.

No estado inicial, ACC-COORD coordena os 2 projetos, ACC-CANONICAL é membro dos 2 e ACC-OUTSIDER não participa de nenhum. US1-01 cria ACC-PENDING em PRJ-MAIN; antes de US1-03, o mesmo placeholder é adicionado a PRJ-ISOLATION para tornar verificável o aviso de exatamente 1 outro projeto. US2-01 cria somente em PRJ-MAIN o vínculo de ACC-ALIAS com ACC-CANONICAL.

## Convenção de resultado e evidência

Cada cenário termina em um dos 4 valores: `Não executado`, `Aprovado`, `Reprovado` ou `Bloqueado`. `Bloqueado` exige causa observada e não conta como aprovação; confirmação por leitura de código também não conta como execução funcional.

A coluna “Atual” descreve somente o que foi observado, com números exatos. A coluna “Evidência” aponta para artefato sob `evidence/issue-183/<run_id>/`, comentário da issue ou URL equivalente autorizada. O nome do arquivo começa pelo ID do cenário, por exemplo `RLS-01-project-list.png`.

Screenshots devem mostrar o usuário de teste, projeto e estado relevante sem expor token ou dado pessoal. Evidência de RLS deve vir da sessão da conta testada; uma consulta com service role não prova autorização do usuário. Logs de banco podem complementar a UI com contagens antes/depois, desde que sanitizados.

## Ordem da execução

Prepare as fixtures e execute T014; depois execute US2-01 e US2-02; com o vínculo ativo, execute RLS-01 a RLS-03 e US2-04; então execute US2-03 e US2-05; por fim execute T031. Essa ordem preserva as pré-condições sem criar contas adicionais e mantém ACC-OUTSIDER alheia até as negativas de RLS terminarem.

## Matriz de cenários

| ID | Tarefa | Referência procedimental | Resultado esperado | Atual | Evidência | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| US1-01 | T014 | [`quickstart.md`](./quickstart.md), US1 passo 1 | 1 membership pendente aparece em PRJ-MAIN com o papel escolhido e `activated_at` nulo. | — | — | Não executado |
| US1-02 | T014 | [`quickstart.md`](./quickstart.md), US1 passo 2 | ACC-PENDING é elegível e recebe a quantidade de assignments indicada na prévia, sem diferença entre prévia e execução. | — | — | Não executado |
| US1-03 | T014 | [`quickstart.md`](./quickstart.md), US1 passo 3 | O e-mail do placeholder muda uma única vez; como ele participa dos 2 projetos, o aviso informa exatamente 1 outro projeto afetado. | — | — | Não executado |
| US1-04 | T014 | [`quickstart.md`](./quickstart.md), US1 passo 4 | No primeiro acesso, ACC-PENDING vê os 2 projetos e seus assignments; o badge pendente some e `activated_at` deixa de ser nulo. | — | — | Não executado |
| US1-05 | T014 | [`quickstart.md`](./quickstart.md), US1 passo 5 | Remover o placeholder nunca ativado elimina seus assignments pendentes; a contagem correspondente volta ao pool e nenhum trabalho iniciado é apagado. | — | — | Não executado |
| US2-01 | T028 | [`quickstart.md`](./quickstart.md), US2 passo 1 | O e-mail ainda sem conta de ACC-ALIAS aparece uma única vez como adicional de ACC-CANONICAL em PRJ-MAIN. | — | — | Não executado |
| US2-02 | T028 | [`quickstart.md`](./quickstart.md), US2 passo 2 | Após o signup, ACC-ALIAS acessa PRJ-MAIN como ACC-CANONICAL, com o mesmo conjunto de assignments, sem merge global dos profiles. | — | — | Não executado |
| US2-03 | T028 | [`quickstart.md`](./quickstart.md), US2 passo 3 | O preview mostra contagens conferidas antes da confirmação; depois dela resta 1 membership canônica, as contagens reconciliam e 0 resposta é perdida. | — | — | Não executado |
| US2-04 | T028 | [`quickstart.md`](./quickstart.md), US2 passo 4 | Tentar reutilizar o e-mail de ACC-ALIAS para outro membro falha e identifica o membro que já possui o vínculo, sem nova linha. | — | — | Não executado |
| US2-05 | T028 | [`quickstart.md`](./quickstart.md), US2 passo 5 | Após desvincular, a conta de origem perde acesso futuro a PRJ-MAIN; respostas, reviews e assignments já migrados permanecem na identidade canônica. | — | — | Não executado |
| RLS-01 | T028 | [`quickstart.md`](./quickstart.md), pontos críticos de RLS | Com o vínculo ativo, ACC-ALIAS vê PRJ-MAIN e não vê PRJ-ISOLATION, embora ACC-CANONICAL participe dos 2. | — | — | Não executado |
| RLS-02 | T028 | [`quickstart.md`](./quickstart.md), pontos críticos de RLS | Antes de entrar no projeto, ACC-OUTSIDER não lê nenhuma linha de `member_email_links` de PRJ-MAIN nem obtém seus e-mails pela UI/API. | — | — | Não executado |
| RLS-03 | T028 | [`quickstart.md`](./quickstart.md), pontos críticos de own rows | ACC-ALIAS codifica, conclui assignment e atua no fluxo de auto-revisão usando a identidade canônica; os registros persistidos contêm somente o profile UUID canônico. | — | — | Não executado |
| REG-01 | T031 | [`tasks.md`](./tasks.md), T031 | ACC-OUTSIDER, já existente, é adicionada como membro ativo de PRJ-MAIN sem criar placeholder ou vínculo. | — | — | Não executado |
| REG-02 | T031 | [`tasks.md`](./tasks.md), T031 | ACC-COORD altera o papel de ACC-OUTSIDER e a leitura posterior retorna exatamente o papel escolhido. | — | — | Não executado |
| REG-03 | T031 | [`tasks.md`](./tasks.md), T031 | ACC-COORD ativa e desativa `can_arbitrate` de ACC-OUTSIDER; cada leitura posterior corresponde ao valor escolhido. | — | — | Não executado |
| REG-04 | T031 | [`tasks.md`](./tasks.md), T031 | ACC-COORD ativa e desativa `can_resolve` de ACC-OUTSIDER; cada leitura posterior corresponde ao valor escolhido. | — | — | Não executado |
| REG-05 | T031 | [`tasks.md`](./tasks.md), T031 | ACC-COORD remove ACC-OUTSIDER; a membership desaparece e a conta volta a não acessar PRJ-MAIN. | — | — | Não executado |

## Registro de desvios

Todo resultado `Reprovado` ou `Bloqueado` recebe uma linha. Se a correção exigir código ou migration, abra issue própria e vincule-a à #183; não transforme este documento em backlog paralelo.

| Cenário | Tipo | Comportamento observado | Issue/PR | Reexecução necessária |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

## Cleanup

O cleanup ocorre somente depois de salvar e revisar a evidência. Primeiro remova PRJ-MAIN e PRJ-ISOLATION pelo fluxo autorizado e confirme que não restam memberships, assignments ou `member_email_links` associados aos 2 UUIDs. Depois remova o placeholder nunca ativado e as 5 identidades descartáveis do tenant Clerk de teste e confirme o tratamento correspondente dos profiles no Supabase.

Não remova contas ou projetos reservados da suíte E2E. Se uma exclusão falhar, interrompa o cleanup, registre as linhas restantes e mantenha a rodada como bloqueada até reconciliação; não execute deleções amplas por domínio de e-mail ou nome parcial.

| Verificação | Esperado | Atual | Evidência | Resultado |
| --- | --- | --- | --- | --- |
| Projetos descartáveis restantes | 0 de 2 | — | — | Não executado |
| Memberships dos 2 projetos restantes | 0 | — | — | Não executado |
| Assignments dos 2 projetos restantes | 0 | — | — | Não executado |
| Vínculos dos 2 projetos restantes | 0 | — | — | Não executado |
| Placeholder auxiliar restante | 0 de 1 | — | — | Não executado |
| Identidades Clerk descartáveis restantes | 0 de 5 | — | — | Não executado |
| Projetos/contas E2E alterados | 0 | — | — | Não executado |

## Critério de decisão

T014 pode ser marcada concluída somente quando US1-01 a US1-05 estiverem `Aprovado`, cada linha tiver evidência revisável e o cleanup não indicar resíduo da US1.

T028 pode ser marcada concluída somente quando US2-01 a US2-05 e RLS-01 a RLS-03 estiverem `Aprovado`. A unificação exige contagens antes/depois que demonstrem 0 resposta perdida; as negativas RLS exigem sessão real de ACC-ALIAS e ACC-OUTSIDER.

T031 pode ser marcada concluída somente quando REG-01 a REG-05 estiverem `Aprovado` com uma conta que já existia antes do teste e sem placeholder ou vínculo criado pelo fluxo legado.

A #183 só está pronta para encerramento quando as 3 tarefas atenderem aos critérios acima, todos os desvios tiverem destino explícito, as 7 verificações de cleanup estiverem `Aprovado` e um revisor diferente do executor tiver conferido a evidência. Até lá, o estado correto deste documento e dos checkboxes em `tasks.md` é pendente.
