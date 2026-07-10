# Research — Caminho de autenticação rápido e recuperável

## D1 — Identidade autenticada reutilizada por request

- Decision: Manter `getAuthUser()` como ponto único de resolução da identidade autenticada no servidor e exigir que ele permaneça envolvido por `cache()` do React para deduplicar `currentUser()`, sincronização Clerk↔Supabase e consultas auxiliares dentro da mesma renderização protegida.
- Rationale: O código atual em `frontend/src/lib/auth.ts` já centraliza a identidade em `getAuthUser()` e usa `cache()`, o que resolve a necessidade imediata de evitar recalcular autenticação para cada layout, page ou helper na mesma request sem criar cache global compartilhado entre usuários.
- Alternatives considered: Repetir `auth()`/`currentUser()` em cada página foi rejeitado porque recria o gargalo da issue #187; cache global ou persistente foi rejeitado porque identidade, impersonação e vínculo de conta são sensíveis a sessão e request.

## D2 — Caminho oficial Clerk/Supabase como padrão

- Decision: O caminho padrão de dados autenticados continua sendo Clerk + JWT template `supabase` + Supabase anon key + RLS, por meio de `createSupabaseServer()` em `frontend/src/lib/supabase/server.ts`.
- Rationale: A constituição exige RLS por padrão e least privilege; o cliente server-side autenticado já passa o token Supabase no header `Authorization`, preservando as policies como boundary de leitura e escrita.
- Alternatives considered: Usar service key para páginas protegidas ordinárias foi rejeitado por violar least privilege e RLS-por-padrão; emitir token local/customizado só pode ser contingência futura, condicionada a medição de performance e revisão de segurança explícita.

## D3 — Preparação e reparo de vínculo não acontecem no render protegido

- Decision: Páginas protegidas devem falhar fechadas quando a sessão existe, mas o vínculo interno está ausente, pendente ou divergente; nesses casos, o usuário deve ser redirecionado para um estado de conclusão/reparo de acesso.
- Rationale: A clarificação da spec determina que o reparo não é silencioso dentro do render path protegido. Isso evita que uma página de projeto misture autorização de dados com mutação de vínculo, reduz ambiguidade para o usuário e mantém o fluxo recuperável.
- Alternatives considered: Continuar chamando `syncClerkUserToSupabase()` como fallback dentro de `getAuthUser()` preserva compatibilidade hoje, mas a feature deve planejar a migração para separar “resolver sessão/vínculo preparado” de “concluir/reparar vínculo”; criar profile/mapping automaticamente em qualquer página protegida foi rejeitado por mascarar divergências.

## D4 — Estados de acesso distinguíveis

- Decision: A implementação deve distinguir quatro resultados mínimos: signed out, signed in com link pendente ou divergente, signed in sem acesso a projeto e falha técnica de sincronização/autorização.
- Rationale: Hoje layouts como `frontend/src/app/(app)/layout.tsx` redirecionam ausência de `userId` para login, enquanto `frontend/src/app/(app)/projects/[id]/layout.tsx` trata ausência de `user` como login e ausência de `project` como `notFound()`. A feature precisa preservar esses caminhos e acrescentar um destino explícito para conclusão/reparo quando a sessão existe, mas o vínculo interno não está pronto.
- Alternatives considered: Mostrar erro genérico foi rejeitado porque não orienta o pesquisador; redirecionar todos os casos para login foi rejeitado porque confunde sessão válida com falta de vínculo; revelar instruções de token/debug foi rejeitado pela FR-010.

## D5 — Autorização por projeto e impersonação

- Decision: `getProjectAccessContext()` continua sendo a leitura request-scoped de projeto + papel, e `resolveEffectiveUserId()` continua sendo a fonte única para filas pessoais que combinam aliases e `viewAs` de master.
- Rationale: O código atual já separa `AuthUser.id` do usuário efetivo em projeto, incluindo `getEffectiveMemberId()` para `member_email_links` e `resolveEffectiveUserId()` para impersonação master. Essa separação é essencial para preservar acesso por e-mail alternativo e impedir que `viewAs` conceda escrita como a identidade visualizada.
- Alternatives considered: Usar diretamente o `user.id` autenticado em todas as páginas foi rejeitado porque quebra aliases; honrar `viewAs` indiscriminadamente foi rejeitado porque poderia ampliar permissões de escrita.

## D6 — Observabilidade e regressão de render path

- Decision: A implementação deve incluir testes e/ou checagens que falhem se o render path protegido voltar a depender de full remote user lookup repetido ou de token customizado legado, além de evidência de que a resolução de identidade ocorre uma vez por request representativa.
- Rationale: A meta de SC-001 e SC-002 só é verificável se houver prova automatizada ou instrumentalizada. Como a lentidão de autenticação é o problema central da issue #187, o plano precisa transformar o requisito em regressão detectável.
- Alternatives considered: Medição manual isolada foi rejeitada como único controle porque regressões de render path reaparecem facilmente em layouts e helpers; confiar apenas em typecheck foi rejeitado porque ele não mede número de resoluções nem latência.

## D7 — Idempotência do vínculo

- Decision: Toda preparação ou reparo de vínculo deve ser idempotente: retry da conclusão de acesso para a mesma conta não pode duplicar `profiles`, `clerk_user_mapping` ou associações de projeto.
- Rationale: `syncClerkUserToSupabase()` e `preregisterSupabaseUser()` já tratam parte das corridas por e-mail/mapping. A feature deve preservar esse padrão e tornar a conclusão/reparo segura para retry pelo usuário.
- Alternatives considered: Criar registros sem consultar vínculo existente foi rejeitado porque viola SC-007 e agrava falhas temporárias; bloquear retry manual foi rejeitado porque deixa pesquisadores presos quando a sincronização inicial falha.
