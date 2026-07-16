# Auditoria de RLS — julho de 2026

## Resultado

Reconstruí o banco local do zero com as 93 migrations versionadas, incluindo `20260716000000_rls_audit_hardening.sql`. O catálogo resultante contém 25 tabelas em `public`, todas com RLS habilitada; 56 policies; 2 views, ambas com `security_invoker=true`; 48 funções, das quais 45 são `SECURITY DEFINER` e as 45 fixam `search_path=''`; 17 funções de trigger sem execução direta pelos papéis da API; 71 foreign keys validadas, das quais 21 são compostas; e 3 tabelas service-only protegidas por RLS deny-by-default sem policies.

A correção elimina writes autenticados genéricos nas relações que representam transições de domínio. `reviews`, `response_equivalences` e `field_reviews` conservam somente leitura por RLS; comparação, equivalência, resolução, auto-revisão e as duas fases de arbitragem passam por RPCs transacionais. Pedidos de exclusão também têm criação e decisão canônicas, e o backfill de versões de resposta deixou de executar updates independentes por linha.

## Causa raiz e contrato adotado

As lacunas tinham uma origem comum: o banco aceitava IDs individualmente válidos sem representar que documento, lote, round, response, review, comentário e projeto pertenciam ao mesmo agregado. Policies e triggers tentavam recuperar essa relação depois do fato, enquanto callers autenticados ainda podiam dividir uma única transição em vários writes. A migration corrige o contrato na origem: 9 colunas estruturais passam a ser `NOT NULL`, 21 relações recebem foreign keys compostas validadas e estados completos de `field_reviews` recebem checks declarativos.

A identidade de trabalho também passa a ter uma única representação por projeto. O índice parcial único `member_email_links_project_linked_user_uniq` impede que o mesmo login alias aponte para dois membros canônicos no mesmo projeto; a foreign key composta exige que o destino seja membership do mesmo projeto; e os triggers de partição impedem self-link, cadeia de aliases e a coexistência do mesmo UUID como alias e membership. Por isso, banco, actions e dashboard fazem um lookup único, sem limite arbitrário de linhas nem lógica defensiva para escolher entre destinos divergentes. Escritas de domínio usam a identidade canônica, enquanto `member_email_links.created_by` conserva o UUID físico da conta autenticada como trilha de auditoria.

Antes das alterações estruturais, a migration faz preflight somente das duas invariantes que as constraints posteriores não conseguem expressar: a semântica do respondente e a elegibilidade do árbitro. `NOT NULL`, foreign keys compostas, checks e índices únicos validam os demais estados diretamente e abortam a migration quando encontram dados malformados, sem repetir os mesmos scans numa tabela temporária. Depois disso, as foreign keys simples redundantes são removidas e resta um caminho estrutural para cada relação.

## Transições atômicas

A superfície autenticada concentra exclusão, comparação, equivalência, resolução e arbitragem em RPCs de domínio. Essas funções não recebem mais o UUID do ator como uma escolha do cliente: derivam a identidade efetiva do JWT e usam esse valor em toda a transação. A RPC `reconcile_auto_review_backlog` permanece exclusiva do `service_role`: recebe o ator já resolvido e o conjunto canônico de `field_reviews`, revalida e bloqueia a autorização, rejeita o lote inteiro se qualquer relação for inválida, remove pendências ausentes do conjunto e deriva os assignments na mesma transação. A loteria também grava assignments, pesos e limites dos participantes numa única RPC. A migration ainda endurece `replace_and_add_documents` e redefine as mutações de permissão, remoção e unificação de membros com autorização explícita e limpeza atômica das filas relacionadas.

O caller de comparação envia os IDs das respostas visíveis e declara se aquela gravação conclui sua atribuição. `submit_compare_review` bloqueia o documento, valida projeto, identidade efetiva e respostas escolhidas, grava o snapshot filtrado, cria o review e atualiza o assignment na mesma transação. A conclusão é calculada no frontend contra a visão canônica sem filtros temporários; `mark_compare_doc_reviewed` cobre a declaração explícita quando não resta campo divergente, e remover uma equivalência reabre apenas os assignments concluídos cujos revisores ainda não analisaram o campo. O cliente não grava mais o status em uma tarefa assíncrona posterior ao commit.

O fluxo de exclusão usa um índice único parcial para tornar irrepresentáveis dois pedidos pendentes para o mesmo documento. A criação e a decisão bloqueiam as linhas relevantes, validam a transição `pending -> approved|rejected` e recalculam o estado derivado do documento. Uma segunda decisão sobre o mesmo pedido falha em vez de sobrescrever o resultado anterior.

Auto-revisão e arbitragem recebem `fieldReviewId`, não uma chave reconstruída a partir de campos mutáveis. Cada RPC valida o lote inteiro antes do primeiro write, exige a ordem self -> blind -> final e trata replay idempotente somente quando o payload é igual ao estado persistido. Os checks declarativos proíbem combinações parciais de veredicto, timestamp, justificativa, árbitro e sugestão.

## Autorização e exposição

Todas as funções de trigger são derivadas de `pg_trigger` e têm `EXECUTE` revogado de `PUBLIC`, `anon`, `authenticated` e `service_role`; os default privileges também deixam novas funções fechadas até um grant intencional. As RPCs de usuário recebem `EXECUTE` apenas para `authenticated`. O papel `service_role` continua executando os triggers por DML, sem poder chamá-los como endpoints.

As policies de leitura usam o contrato unificado de acesso ao projeto, incluindo membro direto, alias, criador e master, e deixam de conservar acesso depois da revogação de membership e alias. As relações sensíveis não expõem `INSERT`, `UPDATE` ou `DELETE` autenticado quando a operação exige uma transição atômica; as RPCs validam autoridade, identidade efetiva e escopo antes de escrever.

## Verificação reproduzível

Os 7 arquivos em `frontend/supabase/tests/*.test.sql` executam em transações com rollback. `rls_audit.test.sql` audita o catálogo, ACLs e uma matriz explícita de 11 policies para membro, alias, coordenador, criador, master, outsider e acesso revogado. `atomic_replace_rpcs.test.sql` cobre autorização, rollback, IDs cross-project, backfill e substituição administrativa. `member_permission_rpcs.test.sql`, `member_unification.test.sql` e `project_members_column_guard.test.sql` cobrem permissões, remoção, unificação de identidade, a partição estrutural entre alias e membership, respostas históricas, autoria canônica nas 3 RPCs de revisão e filas. `rls_workflows.test.sql` cobre exclusão, comparação, equivalência, resolução, arbitragem e a reconciliação atômica do backlog, além das 21 foreign keys compostas e dos estados declarativos. `llm_rate_limit.test.sql`, vindo da migration anterior, prova também a serialização do rate limiter com duas sessões PostgreSQL por `dblink`. A suíte frontend complementar passou em 134 arquivos com 1.269 testes, incluindo resolução de identidade, gates fail-closed, projeção do dashboard e actions.

Para reproduzir a validação local, a fonte canônica é o mesmo comando executado pelo workflow de banco:

```bash
cd frontend
npm run test:db
npm test
npm run typecheck
npm run lint
npm run lint:types
npm run build
npm run react-doctor:diff
npm run fallow:audit
```

O rate limiter tem um teste concorrente real com duas sessões. As decisões de exclusão e a substituição de documentos exercitam o contrato de locks e replays sem uma segunda sessão dedicada. Das 21 foreign keys compostas, 4 recebem tentativas cross-project diretas e as 21 são verificadas no catálogo como existentes e validadas. Essas fronteiras evitam apresentar cobertura estrutural como se fosse um teste concorrente exaustivo.

## Limites operacionais

As contagens descrevem a reconstrução local das migrations versionadas em 16 de julho de 2026. Nenhuma migration foi aplicada ao Supabase remoto e o Security Advisor remoto não foi executado. Antes do merge ou deploy, a lista de migrations e os advisors do projeto remoto devem ser comparados com esta fotografia; eventual drift remoto não é medido por esta auditoria. A unificação bloqueia outras mutações de membership, mas saves já concorrentes não adquirem o mesmo lock: uma gravação iniciada como source pode, em tese, concluir depois da varredura transacional. Fechar essa janela exige que os contratos de escrita adquiram um lock compartilhado na membership efetiva; o teste integrado atual é sequencial e não mede essa fronteira.
