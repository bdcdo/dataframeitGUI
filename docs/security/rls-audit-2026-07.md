# Auditoria de RLS e da superfície de execução — julho de 2026

Documento de resultado da issue #134. Registra o inventário medido do catálogo, os gaps encontrados, o que foi corrigido nesta passagem e o que ficou deliberadamente de fora, com a razão.

## Metodologia

Todas as contagens abaixo foram medidas contra o banco reconstruído do zero por `npx supabase db reset` em 24/07/2026, sobre as 106 migrations versionadas — não estimadas nem herdadas de auditoria anterior. As invariantes viraram a suíte executável `frontend/supabase/tests/rls_audit.test.sql`, registrada como gate em `scripts/run-db-tests.sh`, de modo que o inventário não é uma fotografia num documento: é um teste que roda a cada `npm run test:db`.

Optei por invariantes **estruturais** em vez de listas de nomes. A asserção não diz "estas 28 tabelas têm RLS"; diz "nenhuma tabela de `public` pode estar sem RLS". A diferença importa: uma tabela nova nasce coberta pelo gate sem ninguém precisar lembrar de adicioná-la a uma lista, que é exatamente o modo de falha que a issue #557 expôs em outra camada.

## Inventário medido

| Objeto | Contagem |
|---|---|
| Migrations versionadas e aplicadas | 106 |
| Tabelas em `public` | 28 |
| Tabelas com RLS habilitada | 28 (100%) |
| Views em `public` | 4 |
| Policies | 64 |
| Funções em `public` | 79 |
| Funções `SECURITY DEFINER` | 64 |
| Foreign keys | 78 |
| Suítes de contrato SQL | 14 |

## Gaps encontrados e corrigidos

A auditoria partiu de sete invariantes. Cinco já estavam limpas: RLS habilitada em toda tabela, nenhuma tabela com RLS e sem policy exposta a papel de cliente, nenhuma policy literalmente permissiva (`USING (true)`), todas as views com `security_invoker=true` e `anon` sem SELECT em view. As outras duas acusaram quatro gaps, corrigidos pela migration `20260724120000_rls_audit_hardening.sql`.

Em primeiro lugar, **`handle_new_user()` era `SECURITY DEFINER` sem `search_path` fixado**. Numa função DEFINER, `search_path` mutável permite que o chamador escolha em que schema os nomes não qualificados resolvem, e a função grava lá com os privilégios do owner. O corpo já qualificava `public.profiles`, então fixar o path não alterou comportamento algum — apenas fechou o vetor.

Em segundo lugar, **sete funções de trigger eram executáveis por papel de cliente**, isto é, chamáveis como RPC pelo PostgREST: `handle_new_user`, `enforce_project_schema_revision`, `enforce_projects_column_guard`, `enforce_resolver_column_guard`, `enforce_schema_change_log_column_guard`, `recompute_exclusion_pending` e `resolve_exclusion_requests_on_exclude`. Uma função de trigger invocada fora do seu trigger recebe `NEW`/`OLD` nulos e um `TG_OP` inexistente; com DEFINER, grava com os privilégios do owner. O cruzamento com o gap anterior é o achado mais grave desta auditoria: `handle_new_user` aparecia nas duas listas. A correção revoga de `PUBLIC`, não apenas dos papéis nomeados — toda função em `public` nasce com EXECUTE para PUBLIC, e revogar só de `anon` e `authenticated` deixaria a herança intacta, com `has_function_privilege` continuando verdadeiro.

Em terceiro lugar, **`replace_and_add_documents` e `apply_lottery_assignments` eram executáveis por `anon`**, também por herança de PUBLIC. Confirmei por varredura que as duas são chamadas exclusivamente pelo client de sessão (`createSupabaseServer()` em `actions/documents.ts` e `actions/assignments.ts`), nunca pelo admin client nem pelo backend Python. `authenticated` é, portanto, o único papel que precisa de EXECUTE. Manter `anon` significaria aceitar que uma requisição sem sessão chegasse ao corpo da RPC e dependesse apenas do que ela própria valida — defesa em uma camada só.

Por fim, **`remove_answer_key(uuid,text)` sobrevivia sem nenhum call site** em `frontend/src` ou `backend`. RPC alcançável que ninguém chama é superfície de ataque sem contrapartida; foi removida.

## Contrato de autoria para contas-alias (issue #474)

A #474 relatava que uma conta-alias marcando um campo como ambíguo recebia erro enquanto o veredito ficava gravado. **Medi o caso e a premissa não se sustenta mais.** O `author_id` do comentário automático passou a ser a conta autenticada em 11/06/2026, e o #440 tornou `auth_user_project_memberships()` alias-aware — juntos, os dois resolveram o sintoma antes de a issue ser aberta, em 16/07.

O que a medição mostra hoje, com uma conta-alias autenticada: ela herda o acesso ao projeto do membro canônico, **consegue** criar a pendência de ambiguidade sob a própria conta e **consegue** removê-la; e **não consegue** atribuir a autoria ao membro canônico, porque a policy de INSERT exige `author_id = clerk_uid()`.

Esse último ponto é o critério de aceite nº 3 da issue, e ele contradiz a decisão de desenho registrada em `20260716155000`, segundo a qual a conta bruta permanece a fonte de autoria global. Implementá-lo exigiria afrouxar a policy de INSERT sem nenhum bug por trás, então não o tratei como correção. Os três comportamentos ficaram travados como invariantes **pareadas** na suíte: sozinha, cada metade passaria por vácuo.

## Fora de escopo, com razão

O PR #456 original propunha muito mais. Reconstruí apenas o que medi como aplicável; o restante não entrou pelos motivos abaixo, e as medições já feitas estão anexadas às issues de continuação.

As **RPCs atômicas de comparação, auto-revisão e arbitragem** foram construídas pela `main` por outro caminho depois que aquele PR foi escrito — `record_response_equivalences`, `assign_arbitration_cycles_if_eligible`, o outbox de reconciliação. Portar a versão do #456 substituiria trabalho recente e regrediria #416, #490 e #521.

Os **guards de coluna por trigger** carregam um defeito sistemático: o padrão `to_jsonb(NEW) - ARRAY[...]` nunca resulta em `{}` depois que a tabela ganha qualquer coluna, porque `to_jsonb` materializa colunas nulas. Existe reescrita correta (comparar apenas colunas com valor não-nulo), mas é camada fail-closed nova no write path e um dos guards valida `response_snapshot` contra o estado corrente de `responses` — uma resposta que mude entre montar a tela e gravar a review derrubaria o INSERT. Isso exige o tier de verificação com replay antes de entrar.

O **DDL estrutural** (nove `SET NOT NULL` e vinte FKs compostas project-scoped) foi verificado em parte: medi produção e há **zero nulos** nas nove colunas, e confirmei que os embeds `documents!inner` do PostgREST continuam resolvendo após a troca das FKs de coluna única por compostas — a sonda foi validada com um controle, que acusou `PGRST200` num embed inválido. O que não consegui medir foi a divergência cross-project que o `VALIDATE CONSTRAINT` exige; se houver, o comando aborta o deploy. Falta essa medição para o conjunto entrar com segurança.

## Limites desta auditoria

O inventário cobre o schema `public`. Não auditei `auth`, `storage` nem `realtime`, que são geridos pela plataforma. As duas suítes `schema_revision_*` seguem vermelhas e rastreadas nas issues #571 e #572; não fazem parte do gate. As contagens valem para 24/07/2026 — a suíte executável é que as mantém verdadeiras dali em diante.
