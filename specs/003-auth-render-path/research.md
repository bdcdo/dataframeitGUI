# Research — Caminho de autenticação rápido e recuperável

## D1 — Identidade autenticada reutilizada por request

- Decision: Manter `resolveAuth()` como resolução discriminada e `getAuthUser()` como sua projeção fina, ambos envolvidos por `cache()` do React, para deduplicar `currentUser()` e as leituras de `clerk_user_mapping`/`master_users` dentro da mesma request protegida. O caminho é estritamente read-only.
- Rationale: O código atual em `frontend/src/lib/auth.ts` centraliza o resultado completo em `resolveAuth()` e deriva `getAuthUser()` dele; ambos usam `cache()`, evitando recalcular a identidade para cada layout, page ou helper sem criar cache global compartilhado entre usuários.
- Alternatives considered: Repetir `auth()`/`currentUser()` em cada página foi rejeitado porque recria o gargalo da issue #187; cache global ou persistente foi rejeitado porque identidade, impersonação e vínculo de conta são sensíveis a sessão e request.

## D2 — Caminho oficial Clerk/Supabase como padrão

- Decision: O caminho padrão de dados autenticados continua sendo Clerk + JWT template `supabase` + Supabase anon key + RLS, por meio de `createSupabaseServer()` em `frontend/src/lib/supabase/server.ts`.
- Rationale: A constituição exige RLS por padrão e least privilege; o cliente server-side autenticado já passa o token Supabase no header `Authorization`, preservando as policies como boundary de leitura e escrita.
- Alternatives considered: Usar service key para páginas protegidas ordinárias foi rejeitado por violar least privilege e RLS-por-padrão; emitir token local/customizado só pode ser contingência futura, condicionada a medição de performance e revisão de segurança explícita.

## D3 — Preparação e reparo de vínculo não acontecem no render protegido

- Decision: Páginas protegidas devem falhar fechadas quando a sessão existe, mas o vínculo interno está ausente, pendente ou divergente; nesses casos, o usuário deve ser redirecionado para um estado de conclusão/reparo de acesso.
- Rationale: A clarificação da spec determina que o reparo não é silencioso dentro do render path protegido. Isso evita que uma página de projeto misture autorização de dados com mutação de vínculo, reduz ambiguidade para o usuário e mantém o fluxo recuperável.
- Alternatives considered: Chamar `reconcileClerkUserAccess()` como fallback dentro de `resolveAuth()` foi rejeitado porque misturaria autorização e mutação no render; criar profile/mapping em qualquer página protegida também mascararia divergências. A reconciliação fica nos webhooks e na action explícita `completeAccess()`.

## D4 — Estados de acesso distinguíveis

- Decision: A implementação deve distinguir quatro resultados mínimos: signed out, signed in com link pendente ou divergente, signed in sem acesso a projeto e falha técnica de sincronização/autorização.
- Rationale: Os layouts atuais enviam `signed-out` ao login, estados de vínculo/falha técnica à conclusão de acesso e somente ausência real de projeto visível a `notFound()`. Essa classificação impede que uma falha de identidade se apresente como logout ou projeto inexistente.
- Alternatives considered: Mostrar erro genérico foi rejeitado porque não orienta o pesquisador; redirecionar todos os casos para login foi rejeitado porque confunde sessão válida com falta de vínculo; revelar instruções de token/debug foi rejeitado pela FR-010.

## D5 — Autorização por projeto e impersonação

- Decision: `getProjectAccessContext(projectId, user)` é a leitura request-scoped que resolve projeto, papel, `accountUserId` e `memberUserId`; `resolveProjectMemberActor(projectId)` é a porta única das mutations pessoais; `resolveProjectQueueIdentity(access, viewAsUser)` é a fonte única para a fila visualizada.
- Rationale: O contexto discriminado `resolved | unavailable` separa a conta autenticada do membro canônico sem propagar autorização parcial. O gate de mutation devolve ator e membro juntos ou uma falha classificada, enquanto a projeção de fila preserva aliases e aplica `viewAs` somente para master, sem conceder escrita como a identidade visualizada.
- Alternatives considered: Usar diretamente o `user.id` autenticado em todas as páginas foi rejeitado porque quebra aliases; honrar `viewAs` indiscriminadamente foi rejeitado porque poderia ampliar permissões de escrita.

## D6 — Observabilidade e regressão de render path

- Decision: A implementação deve incluir testes e/ou checagens que falhem se o render path protegido voltar a depender de full remote user lookup repetido ou de token customizado legado, além de evidência de que a resolução de identidade ocorre uma vez por request representativa.
- Rationale: A meta de SC-001 e SC-002 só é verificável se houver prova automatizada ou instrumentalizada. Como a lentidão de autenticação é o problema central da issue #187, o plano precisa transformar o requisito em regressão detectável.
- Alternatives considered: Medição manual isolada foi rejeitada como único controle porque regressões de render path reaparecem facilmente em layouts e helpers; confiar apenas em typecheck foi rejeitado porque ele não mede número de resoluções nem latência.

## D7 — Idempotência do vínculo

- Decision: Toda preparação ou reparo de vínculo deve ser idempotente: retry da conclusão de acesso para a mesma conta não pode duplicar `profiles`, `clerk_user_mapping`, aliases ou memberships.
- Rationale: `reconcileClerkUserAccess()` reutiliza o mapping do mesmo Clerk ID ou chama `claim_clerk_supabase_identity`, que sob a trava global só reclama um placeholder pendente e sem mapping; não há upsert capaz de reatribuir um `supabase_user_id` já pertencente a outra conta. `preregisterSupabaseUser()` reutiliza apenas profile ainda reclamável. A mesma geração pode ser concluída novamente depois de falha parcial.
- Alternatives considered: Criar registros sem consultar vínculo existente foi rejeitado porque viola SC-007 e agrava falhas temporárias; bloquear retry manual foi rejeitado porque deixa pesquisadores presos quando a sincronização inicial falha.

## D8 — Clerk atual é autoridade e a reconciliação usa geração em duas fases

- Decision: `reconcileClerkUserAccess(clerkUserId)` sempre relê o usuário atual no Clerk. O primário precisa existir e estar verificado; todos os e-mails verificados formam a lista completa de aliases. `User.updatedAt` é a geração do snapshot. `begin_clerk_access_snapshot` grava marker `0` e escolhe a geração numa transação; `complete_clerk_access_snapshot` só aceita essa geração e aplica profile, aliases e marker `1` atomicamente. Metadata é o último efeito. Snapshot superado causa uma releitura e uma única nova tentativa.
- Rationale: O begin commitado impede que uma falha de conclusão preserve acesso do estado anterior; a geração impede evento atrasado de restaurar aliases removidos. A segunda fase mantém os efeitos locais coerentes entre si, e metadata por último impede que um JWT anuncie uma identidade ainda incompleta.
- Alternatives considered: Uma única RPC não consegue invalidar o marker de forma durável se a própria transação falhar; atualizar aliases e marker em requests separados cria janela fail-open; confiar na ordem de entrega do webhook foi rejeitado porque o Svix pode repetir ou atrasar eventos.

## D9 — Revogação fail-closed e separação entre lookup administrativo e posse

- Decision: Sem primário verificado, mapping existente recebe snapshot com aliases vazios e sem ativação, permanecendo com marker `0`; mapping ausente não é criado. `user.deleted` e releitura 404 executam `begin_clerk_user_revocation` (marker `0`, `clerk_deleted = true`) e `complete_clerk_user_revocation` (aliases vazios). Em actions administrativas, `profileByEmail` é apenas a linha encontrada por `profiles.email`, enquanto `ownerProfile` vem do mapping da conta cuja posse atual foi confirmada no Clerk.
- Rationale: Endereço salvo em profile, metadata e evento antigo podem estar obsoletos. Separar os conceitos evita transformar coincidência textual em identidade autenticável e garante que token antigo perca efeito assim que o marker é invalidado.
- Alternatives considered: Manter aliases até aparecer um novo primário foi rejeitado por fail-open; apagar profiles/histórico em `user.deleted` foi rejeitado porque identidade de trabalho e auditoria precisam permanecer; usar `profileByEmail` como fallback do dono atual foi rejeitado porque pré-registro não prova posse.
