# Auditoria da Supabase service role — julho de 2026

## Resultado

O baseline de `origin/main` tinha 11 módulos de produção com import runtime de `createSupabaseAdmin`, 1 módulo com import apenas de tipo e 27 chamadas ao factory. A árvore atual reduz o runtime para 9 módulos e 18 chamadas: 9 chamadas foram eliminadas, sem criar um segundo factory ou um caminho alternativo para a mesma operação.

Das 18 chamadas restantes no runtime Next, 15 são necessárias para um contrato que o usuário autenticado não pode cumprir — bootstrap de identidade, Supabase Auth Admin, escrita automática iniciada por pesquisador, reconcile exclusivo do service role, webhook assinado ou dados de cache sem request — e 3 são débitos delimitados. Não encontrei import direto em componente `"use client"`, nem caminho runtime comum que leve um Client Component ao módulo admin. O módulo importa `server-only`, de modo que o compilador Next também rejeita regressões transitivas.

## Método

Inventariei todos os imports e call sites dos módulos de produção de `frontend/src`, excluindo testes e test utilities, e analisei os chamadores, os gates de autenticação, as policies RLS correspondentes e o tipo de superfície Next: Server Action, React Server Component, route handler ou biblioteca interna. O teste `supabase-admin-boundary.test.ts` é a fonte executável dessas contagens: usa a AST do TypeScript para distinguir imports runtime de `import type`, reconhecer diretivas apenas no directive prologue, resolver imports relativos e `@/` e incluir import/export estático, `import = require`, `require()` e `import()` no grafo. Especificadores compostos apenas por texto constante são resolvidos; qualquer carga dinâmica que não possa ser determinada estaticamente falha fechado.

Também procurei nomes de secret nos fontes, scripts, backend, documentação e arquivos versionados de configuração. A varredura recursiva exclui diretórios gerados e nunca lê arquivos locais `.env*`, mas cobre exemplos versionáveis. Há 0 variável com prefixo `NEXT_PUBLIC_` cujo restante do nome contenha um dos quatro marcadores sensíveis cobertos pelo teste. O frontend e os scripts usam `SUPABASE_SERVICE_ROLE_KEY`, enquanto o backend Fly usa `SUPABASE_SERVICE_KEY`; nenhum deles tem prefixo público.

## Antes e depois

| Métrica no runtime Next | Baseline | Proposta | Variação |
|---|---:|---:|---:|
| Módulos com import runtime do admin factory | 11 | 9 | -2 |
| Módulos com import apenas de tipo | 1 | 1 | 0 |
| Chamadas estáticas a `createSupabaseAdmin()` | 27 | 18 | -9 |
| Módulos `"use client"` com import direto | 0 | 0 | 0 |
| Caminhos comuns Client Component → admin no grafo | 0 | 0 | 0 |
| Marcador compilável `server-only` no módulo do secret | 0 | 1 | +1 |

## Usos substituídos por RLS

| Arquivo/caminho | Chamadas removidas | Substituição |
|---|---:|---|
| `app/(app)/dashboard/page.tsx` | 1 | Master lista `projects` com o cliente autenticado; a policy `is_master()` já cobre o papel |
| `app/(app)/projects/[id]/config/members/page.tsx` | 1 | O scan read-only do backlog reutiliza o cliente autenticado da página protegida |
| `actions/members.ts` | 2 | `setCanCompare` e `unlinkMemberEmail` reutilizam o cliente autenticado depois do gate/RLS |
| `actions/field-reviews.ts` | 2 | Retry coordinator-only usa RLS; `assignArbitrator` recebe o cliente do caller, admin para pesquisador e autenticado para coordenador. O reconcile mantém somente o INSERT de `field_reviews` no service role porque a #134 proíbe esse INSERT para qualquer sessão autenticada |
| `lib/auth.ts` | 1 | Resolução de alias consulta `member_email_links` com o JWT do próprio usuário |

As substituições preservam a fonte de autorização na policy. Em particular, o helper `assignArbitrator` deixou de criar um admin client internamente: o caller torna explícito qual papel executa o fluxo. Isso evita que um retry já autorizado como coordenador volte a ganhar service role dentro de uma função privada. A resolução de identidade também deixou de usar admin: consulta os vínculos visíveis ao usuário autenticado e falha fechado quando a query ou o contrato de identidade falha.

## Inventário restante no runtime Next

| Arquivo | Chamadas | Superfície | Classificação e justificativa |
|---|---:|---|---|
| `actions/members.ts` | 4 | Server Actions | Obrigatórias: busca global/pré-registro, Auth Admin, vínculo por e-mail e RPC `unify_project_members` |
| `actions/field-reviews.ts` | 3 | Server Actions | Obrigatórias: efeitos automáticos iniciados por pesquisador, comentário canônico de arbitragem e reconcile de `field_reviews`, reservado ao service role |
| `actions/comparisons.ts` | 1 | Server Action | Débito delimitado: o retry cria assignments pelo helper privilegiado; o factory só é instanciado depois do gate, do modo, do backlog e da leitura de carga, imediatamente antes do primeiro write |
| `app/(app)/projects/[id]/analyze/assignments/page.tsx` | 2 | RSC com `unstable_cache` | Débito justificado no desenho atual: funções privadas fazem leituras cacheadas sem request/JWT, depois de gate próprio de sessão e acesso atual na page |
| `app/api/webhooks/clerk/route.ts` | 1 | Route handler | Obrigatória: depois de verificar a assinatura Svix, ativa profiles e resolve vínculos pendentes |
| `lib/auth.ts` | 2 | Biblioteca server-side | Obrigatórias: `clerk_user_mapping` e `master_users` são tabelas RLS deny-by-default usadas no bootstrap da identidade antes de existir um cliente autenticado confiável |
| `lib/auto-comparison.ts` | 1 | Biblioteca interna | Obrigatória: um pesquisador conclui a codificação e materializa assignment para outro revisor, operação coordinator-only na RLS |
| `lib/auto-review.ts` | 1 | Biblioteca interna | Obrigatória: o pesquisador dispara materialização idempotente de assignments e `field_reviews` |
| `lib/clerk-sync.ts` | 3 | Biblioteca server-side | Obrigatórias: criação/alteração em `auth.users`, ativação de profile e manutenção de `clerk_user_mapping` |

`lib/auto-revisao-sync.ts` mantém 1 `import type` do factory para expressar o shape do cliente. Esse import é apagado pelo TypeScript e o próprio módulo já contém `import "server-only"`.

## Gates de autorização dos usos restantes

Os usos obrigatórios não ficam autorizados apenas por estarem em arquivo server-side. `submitAutoReview`, por exemplo, precisa da service role para criar efeitos que um pesquisador não pode materializar pela RLS; esta proposta passa a revalidar `getProjectAccessContext` no entrypoint antes de criar o admin client. O teste prova que um usuário sem acesso atual recebe `Projeto não encontrado ou inacessível`, cria 0 admin clients e produz 0 writes. Isso fecha o caso em que uma linha histórica pudesse acionar o bypass depois da remoção do projeto.

`submitFinalVerdicts` também passou a instanciar o admin client somente depois da leitura autenticada dos `field_reviews` e das validações de documento, fase, autoria e blind review. Uma submissão ausente, bloqueada ou composta apenas de escolhas humanas cria 0 admin clients; o factory é chamado 1 vez apenas quando ao menos uma decisão LLM precisa materializar o efeito privilegiado.

As Server Actions de equipe que permanecem com admin client chegam à chave apenas depois de um gate de coordenador ou de uma mutation filtrada pela RLS. O PR #433 corrige dois débitos já identificados pela mesma classe de ataque: adiciona o gate ausente em `releaseArbitrationsFromUser` e vincula `memberId` ao `projectId` nas mutations de equipe. Não repliquei esse diff aqui para evitar dois PRs concorrentes sobre os mesmos entrypoints.

O helper comum de mutations coordinator-only agora também cumpre seu contrato fail-closed: `isProjectCoordinator` retorna `false` quando qualquer leitura de `getProjectAccessContext` falha, mesmo que a resposta parcial identifique o usuário como criador ou master. Antes, `queryFailed` era registrado, mas ignorado pelo gate — uma consulta parcial ainda podia liberar actions que chegavam à service role.

Os 2 usos da página de assignments são privados ao módulo RSC, não são exports `"use server"` e recebem apenas o `projectId` da rota. Como layout e page podem renderizar em paralelo no App Router, a própria page agora revalida sessão e acesso atual ao projeto antes de chamar qualquer reader cacheado/admin; o teste prova que sessão ausente, projeto inacessível ou erro da consulta criam 0 admin clients. A service role existe porque `unstable_cache` é compartilhado entre requests e, portanto, não pode capturar um JWT individual. O caminho futuro mais estreito seria uma RPC de leitura com contrato próprio ou cachear somente depois de uma consulta autenticada; até lá, o teste de fronteira garante que esses readers não sejam importados pelo cliente.

## Outras superfícies da service key

| Superfície | Construções de cliente | Bundle de navegador | Classificação |
|---|---:|---|---|
| `scripts/comentarios-relatorio/fetch-open-comments.ts` | 1 | Fora do grafo Next | CLI manual read-only, precisa ler comentários de projeto sem sessão Clerk |
| `scripts/comentarios-relatorio/apply-decisions.ts` | 1 | Fora do grafo Next | CLI manual de aplicação de decisões, precisa alterar schema e resolver comentários em lote |
| `backend/services/supabase_client.py` | 1 singleton lazy | Processo FastAPI no Fly | Serviço LLM escreve `llm_runs`, responses LLM e resultados para múltiplos usuários; service key é o contrato do backend |

Os dois scripts estão sob `frontend/scripts`, não são importados por `frontend/src` e só executam quando chamados explicitamente no terminal. O backend lê `SUPABASE_SERVICE_KEY` pelo Pydantic Settings e nunca participa do build Next. Essas 3 superfícies não foram contadas nas 18 chamadas do runtime frontend porque têm processos e fronteiras de deploy distintos.

## Proteções adicionadas

`frontend/src/lib/supabase/admin.ts` agora começa com `import "server-only"`. Além disso, o factory substitui as duas non-null assertions por validação runtime: ausência de URL ou service role key lança um erro explícito antes de construir um cliente malformado. A chave continua lida somente dentro da função, sem exportar valor, singleton ou objeto serializável.

O teste estrutural fixa o inventário dos 9 importadores runtime e das 18 chamadas. Uma nova importação ou chamada exige atualizar conscientemente o inventário. O mesmo teste falha se surgir um caminho comum de import a partir de Client Component, se o marcador `server-only` for removido, se outro módulo de produção passar a ler o secret, se `require` ou import dinâmico introduzir um caminho oculto ou não-estático, ou se alguém criar qualquer nome público com marcador sensível. A varredura inclui `.env.example`/templates e scripts shell versionáveis e compara nomes sem depender de caixa alta.

## Verificação

Os testes focados cobrem acesso revogado, fronteira AST, resolução fail-closed de identidade e instanciação tardia do admin client. A suíte completa passou em 134 arquivos, com 1.269 testes; `tsc --noEmit`, `next build`, lint comum e lint tipado também passaram. React Doctor encontrou 0 problemas e marcou 91/100; Fallow encontrou 0 achados novos contra `origin/main`; Gitleaks e Semgrep passaram. Permanece 1 warning herdado e fora do diff em `src/hooks/__tests__/useCachedResource.test.ts:77`.

Esta árvore não pode ser composta automaticamente com as propostas adjacentes. A #440 define a identidade canônica, a #446 altera o contrato de equivalências e a #450 altera a remoção transacional de membros; todas sobrepõem arquivos e migrations deste PR. A ordem registrada no PR é #440 → #446 → #450 → rebase desta árvore sobre `main`, com remoção dos trechos absorvidos e repetição dos gates.

## Dependências entre propostas

Esta auditoria integra o endurecimento de RLS da issue #134, mas permanece bloqueada por #440, #446 e #450. O rebase posterior deve preservar os contratos canônicos dessas três propostas e eliminar qualquer implementação duplicada, em vez de escolher um lado do conflito sem revalidar o conjunto.
