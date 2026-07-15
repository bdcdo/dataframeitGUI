# Auditoria de RLS — julho de 2026

## Resultado

Reconstruí o banco do zero com as 89 migrations que antecedem esta proposta e auditei o catálogo resultante. O baseline versionado contém 24 tabelas em `public`, todas com RLS habilitada; 62 policies, nenhuma literalmente `USING (true)` ou `WITH CHECK (true)`; 2 views, ambas com `security_invoker=true`; e 18 funções, das quais 15 são `SECURITY DEFINER`. A cobertura nominal de RLS estava completa, mas 10 grupos de lacunas ainda permitiam conservar acesso revogado, combinar chaves de projetos diferentes, falsificar autoria e metadados ou chamar funções de trigger como RPC.

Esta proposta recria 29 policies, mantendo o total em 62: remove os dois caminhos autenticados de `INSERT` em `field_reviews` – a policy própria e o braço `FOR ALL` administrativo – e substitui a administração por policies separadas de `UPDATE` e `DELETE`. Também cria 10 guardas fail-closed, amplia o trigger derivado de exclusões, fecha a execução direta de todas as funções alcançadas por `pg_trigger`, fecha os default privileges para funções futuras, restringe 2 RPCs ao papel `authenticated`, remove 1 RPC órfã, retira `SELECT` de `anon` em 1 view e cria 1 índice composto. Isoladamente, a migration deixa 27 funções em `public`, das quais 25 são `SECURITY DEFINER` com `search_path=''`.

## Método e limites

Usei como fonte de verdade os arquivos versionados em `frontend/supabase/migrations`, aplicados em ordem lexicográfica a um Postgres descartável `public.ecr.aws/supabase/postgres:15.8.1.085`, a mesma linha PostgreSQL 15 usada pelo Supabase. O único objeto auxiliar fora das migrations foi um stub mínimo de `auth.jwt()` para reproduzir os claims da API; nenhum dado ou schema remoto foi alterado. Consultei `pg_class`, `pg_policies`, `pg_proc`, `pg_trigger`, `pg_default_acl`, `pg_constraint`, `pg_indexes`, os grants efetivos e os chamadores em `frontend/src`.

As contagens acima descrevem a reconstrução versionada, não eventual drift manual no projeto remoto. Não executei o Security Advisor remoto porque esta auditoria não recebeu autorização para operar o projeto Supabase. Antes do merge, recomendo comparar `supabase migration list` e os advisors remotos com esta fotografia.

O PostgreSQL reutiliza `USING` como `WITH CHECK` em policies `ALL` e `UPDATE` quando `WITH CHECK` é omitida. Por isso, `WITH CHECK IS NULL` não foi tratado automaticamente como vulnerabilidade. Para writes sensíveis, combinei policies de seleção de linha com triggers que validam o domínio e comparam `to_jsonb(NEW)` e `to_jsonb(OLD)` contra allowlists; uma coluna futura fica proibida até ser classificada explicitamente.

## Inventário de tabelas e policies

| Tabela | Policies após a proposta | Resultado da auditoria |
|---|---:|---|
| `assignment_batches` | 2 | Leitura/administração preservadas; novo guard vincula `created_by` ao caller, torna identidade imutável e o índice cobre `(project_id, created_at DESC)` |
| `assignments` | 3 | Leitura correta; mutação agora exige membership atual, documento/lote do mesmo projeto e separa payload do pesquisador, administração e identidade imutável |
| `clerk_user_mapping` | 0 | RLS deny-by-default; sem acesso de `anon` ou `authenticated` |
| `difficulty_resolutions` | 3 | Leitura unificada; INSERT agora vincula response, documento e projeto e produz autoria/timestamp no banco |
| `documents` | 2 | Sem lacuna encontrada |
| `error_resolutions` | 3 | Leitura unificada; INSERT agora vincula documento e projeto e produz autoria/timestamp no banco |
| `field_reviews` | 5 | Nenhum papel autenticado pode inserir; UPDATE administrativo e as fases humana/arbitral têm contratos separados; responses, documento, identidades e elegibilidade do árbitro são validados |
| `llm_runs` | 1 | Leitura passou a incluir aliases e master |
| `master_users` | 0 | RLS deny-by-default; sem acesso de `anon` ou `authenticated` |
| `member_email_links` | 2 | Sem lacuna adicional; a FK composta da proposta #450 fecha alias sem membership |
| `note_resolutions` | 3 | Leitura unificada; INSERT agora vincula response e projeto e produz autoria/timestamp no banco |
| `profiles` | 1 | Teammates agora reconhecem acesso unificado, inclusive alias e criador |
| `project_comments` | 7 | Leitura/criação unificadas; documento e parent precisam pertencer ao projeto; autoria, resolução e colunas estruturais são fail-closed |
| `project_members` | 3 | Leitura passou a usar a fonte unificada de acesso |
| `projects` | 3 | Leitura passou a usar a fonte unificada de acesso |
| `question_meta` | 2 | Sem lacuna encontrada |
| `researcher_field_orders` | 4 | `UPDATE` e `DELETE` agora exigem acesso atual ao projeto |
| `response_equivalences` | 2 | A proposta #446 corrige a identidade efetiva da policy; esta migration acrescenta o guard estrutural de projeto, documento, responses, reviewer e timestamp |
| `responses` | 2 | Sessão autenticada grava apenas a response humana da identidade efetiva, com documento, schema, hashes, round, nome e timestamps canônicos |
| `reviews` | 2 | Reviewer, documento, resposta escolhida, resolução, timestamp e snapshot são validados; snapshot histórico inalterado não é reinterpretado em updates posteriores |
| `rounds` | 2 | Leitura passou a incluir aliases e master |
| `schema_change_log` | 3 | Sem lacuna encontrada |
| `schema_suggestions` | 3 | Criação vincula caller e estado `pending`; resolução administrativa não pode reescrever a proposta nem falsificar `resolved_by` |
| `verdict_acknowledgments` | 4 | Acesso próprio exige projeto atual; autoria, identidade, payload do respondente e metadados administrativos têm allowlists separadas |

## Lacunas comprovadas e correções

### 1. Posse de uma linha sobrevivia à revogação do projeto

`auth_user_member_identity_ids(project_id)` sempre inclui o usuário atual e pode incluir uma identidade canônica por alias. Policies de `assignments`, `responses`, `reviews`, `field_reviews`, `researcher_field_orders`, `project_comments` e `verdict_acknowledgments` usavam identidade sem exigir simultaneamente `auth_user_accessible_project_ids()`. A correção compõe as duas condições. O teste remove membership e link, depois prova que a conta direta e o alias deixam de ler o projeto e atualizam 0 responses históricas.

### 2. Policies de linha própria autorizavam colunas administrativas

Policies escolhem linhas, não colunas. Sem guardas, um pesquisador podia trocar `assignments.type`, `responses.respondent_name`, a identidade de um review ou colunas da fase arbitral em `field_reviews`; administradores podiam reatribuir identidades estruturais em linhas que deveriam ser históricas. Os novos triggers separam payload do pesquisador, payload administrativo e identidade imutável. A comparação fail-closed também impede que uma coluna adicionada no futuro entre silenciosamente numa superfície autenticada.

### 3. INSERT podia combinar objetos de projetos diferentes

FKs simples garantiam apenas que cada UUID existia. Não garantiam que `project_id`, documento, response, review, lote e parent pertenciam ao mesmo domínio. Os guardas agora validam essas relações em `assignments`, nas 3 tabelas de resolução, `project_comments`, `responses`, `reviews`, `response_equivalences` e `field_reviews`, inclusive quando a escrita passa pelo service role.

### 4. Autoria, versão e timestamps eram controlados pelo caller

Responses humanas agora derivam `respondent_name` do profile, exigem `answer_field_hashes` calculado a partir de `projects.pydantic_fields`, schema/semver atuais, `round_id` compatível com a estratégia e timestamps do banco. Reviews, equivalências, batches, resoluções, sugestões e acknowledgments também vinculam ator e timestamp à sessão. Payloads com `resolved_by`, `created_by`, reviewer ou respondent alheios não persistem.

Esse contrato é deliberadamente estrito para `INSERT` e `UPDATE` direto. A implementação de gravação parcial da #216 não deve relaxar o guard para aceitar um mapa incompleto: deverá usar uma RPC atômica dedicada, com optimistic concurrency, que ajuste ou substitua o braço de `UPDATE`, atualize os hashes apenas dos campos tocados e preserve os hashes stale dos campos não tocados. O teste desta auditoria fixa a fronteira atual ao rejeitar tanto hash forjado quanto mapa incompleto em `UPDATE` direto.

### 5. `field_reviews` ainda aceitava INSERT administrativo autenticado

Remover apenas `Self reviewer inserts own row` não bastava: a policy histórica `Coordinators manage field_reviews FOR ALL` mantinha INSERT para coordenador, criador e master. Não existe caller autenticado legítimo; a criação inicial e o reconcile usam admin client. A proposta remove ambos os caminhos e cria policies administrativas apenas para `UPDATE` e `DELETE`. O teste tenta INSERT como alias, coordenador, criador, master e outsider e comprova rejeição em todos os casos.

### 6. O estado derivado de pedidos de exclusão podia ficar órfão

O trigger de `documents.exclusion_pending_at` reagia apenas a campos de resolução e, num UPDATE, recalculava somente `NEW.document_id`. Ele agora observa `document_id`, `kind`, `resolved_at` e `rejected_at`, recalcula OLD e NEW e preserva o vínculo de projeto. Atores autenticados não podem mover a linha estruturalmente; o teste usa uma escrita administrativa controlada para provar a recomputação bilateral.

### 7. O contrato de leitura havia divergido entre tabelas

A aplicação trata membro, alias, criador sem membership e master como acessos válidos, mas 11 policies ainda consultavam memberships ou helpers antigos diretamente. As policies afetadas agora usam `auth_user_accessible_project_ids()` e `is_master()`. A matriz SQL verifica cada tabela representativa individualmente, sem pressupor uma contagem total de linhas ou objetos.

### 8. `lottery_doc_stats` ainda era legível por `anon`

A view já usava `security_invoker=true`, mas o default grant do Supabase havia concedido `SELECT` a `anon`. A migration revoga esse acesso e o teste verifica as duas views públicas.

### 9. Funções de trigger estavam expostas como RPC, inclusive no futuro

A migration deriva as funções atuais pelo join `pg_trigger.tgfoid = pg_proc.oid` e revoga `PUBLIC`, `anon`, `authenticated` e `service_role`. Além da fotografia atual, `ALTER DEFAULT PRIVILEGES` remove o EXECUTE global de `PUBLIC` e os grants explícitos de `anon`, `authenticated` e `service_role` no schema `public` para o papel que executa migrations. No Supabase local, esse papel e o owner real das funções são `postgres`. O teste cria uma nova função de trigger como `postgres`, confirma ACL apenas do owner e depois prova que os triggers continuam executando em DML do service role sem grant RPC direto.

### 10. RPCs e índice divergiam dos callers

`apply_lottery_assignments` e `replace_and_add_documents` são `SECURITY INVOKER` chamadas pelo cliente autenticado; seus grants agora excluem `PUBLIC`, `anon` e `service_role`. `remove_answer_key(uuid,text)` não tinha caller e permitia alterar JSON fora de `saveResponse`, por isso foi removida. `assignment_batches`, filtrada por projeto e ordenada por data, ganhou `idx_assignment_batches_project_created(project_id, created_at DESC)`.

## Matriz de papéis validada

| Papel | Leitura representativa | Mutação própria | Administração |
|---|---|---|---|
| Pesquisador membro | Permitida | Permitida apenas no payload próprio | Negada |
| Conta-alias | Permitida como identidade efetiva | Permitida na identidade canônica quando o objeto usa identidade efetiva; autoria de conta permanece direta onde o contrato exige `clerk_uid()` | Herda papel canônico somente pelas policies que o modelam |
| Coordenador membro | Permitida | Permitida na própria identidade | Permitida nas allowlists administrativas; INSERT de `field_reviews` negado |
| Criador sem membership | Permitida | Permitida na própria identidade | Permitida nas allowlists administrativas; INSERT de `field_reviews` negado |
| Master | Permitida | Permitida na própria identidade | Permitida nas allowlists administrativas; INSERT de `field_reviews` negado |
| Outsider autenticado | Negada | Negada | Negada |
| Ex-membro direto ou alias | Negada após remoção | Negada após remoção | Negada |

## Verificação reproduzível

`frontend/supabase/tests/rls_audit.test.sql` executa em `BEGIN ... ROLLBACK` e verifica invariantes relacionais, não totais rígidos: toda tabela `public` tem RLS; uma tabela sem policy não concede DML a `anon` nem `authenticated`; nenhuma policy é literalmente aberta; toda view é invoker; todo definer fixa `search_path=''`; nenhuma função de trigger é executável diretamente pelos papéis da API; e cada RPC conhecida tem grants intencionais. Essa forma aceita a tabela service-only `llm_rate_limit_buckets` da proposta #135, que tem RLS sem policies e revoga todos os grants de tabela.

A matriz de mutação cobre alias canônico, coordenador, criador, master, outsider, ex-membro direto e alias; documento, parent, batch, response e chosen-response cross-project; autoria e timestamps; hashes/schema/round; snapshots; resoluções, sugestões e acknowledgments; as duas fases de `field_reviews`; ausência de INSERT autenticado nessa tabela; recomputação bilateral de exclusão; e DML pelo service role com triggers sem EXECUTE direto.

`frontend/supabase/tests/atomic_replace_rpcs.test.sql` conserva as fixtures canônicas exigidas por esta auditoria e incorpora a cobertura da proposta #450: histórico de ex-membro, reabertura apenas de membership ativa e rollback do lote quando uma pendência órfã é rejeitada. Assim, a integração não substitui a cobertura concorrente por uma versão menor do teste.

## Ordem com propostas concorrentes

A ordem validada é: #446 (`20260715120000_response_equivalences_alias_rls.sql`), #450 (`20260715130000_remove_project_member_atomic.sql`), esta proposta (`20260715140000_rls_audit_hardening.sql`) e #135 (`20260715150000_llm_rate_limit.sql`). Na árvore completa, o catálogo resultante tem 25 tabelas, todas com RLS; 62 policies; 31 funções, das quais 29 são definers; 18 funções de trigger; e 3 tabelas deny-by-default sem policy (`clerk_user_mapping`, `master_users` e `llm_rate_limit_buckets`). Os testes não codificam esses totais como contrato, mas registrei-os aqui como evidência da reconstrução executada.

A #446 continua responsável pela policy de identidade efetiva em `response_equivalences`; esta auditoria adiciona o guard estrutural que falta depois dessa policy. A #450 continua responsável pela FK composta de aliases, pela invariante de assignments pendentes e pela remoção transacional. A #135 cria uma tabela sem policies e uma RPC exclusiva do service role; o default ACL fechado pela #134 faz a função nascer sem exposição e a #135 concede somente o EXECUTE necessário.
