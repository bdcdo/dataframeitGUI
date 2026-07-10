# Contract — Regression Checks

## Purpose

Definir as evidências mínimas para impedir regressão de performance ou segurança no render path autenticado.

## Checks

### RC-001 — Deduplicação por request

- Given uma página protegida representativa com layout pai, layout de projeto e múltiplas leituras independentes.
- When a página renderiza em uma única request server-side.
- Then a identidade autenticada é resolvida uma vez e reutilizada pelos consumidores da request.

### RC-002 — Sem lookup remoto completo no caminho crítico preparado

- Given usuário autenticado com vínculo interno já preparado.
- When dashboard ou página de projeto protegida renderiza.
- Then o caminho crítico não depende de full remote identity-provider lookup para cada render protegido.

### RC-003 — Caminho oficial Supabase/RLS

- Given página protegida ordinária.
- When ela lê dados de projeto.
- Then usa JWT do usuário via integração oficial Clerk/Supabase e policies RLS continuam sendo boundary.

### RC-004 — Sem token customizado legado

- Given código novo ou alterado na autenticação server-side.
- When a regressão é verificada.
- Then a checagem falha se o caminho legado de token customizado reaparecer como fluxo ordinário de páginas protegidas.

### RC-005 — Fail-closed de vínculo ausente

- Given sessão Clerk válida com vínculo interno ausente ou divergente.
- When página protegida tenta renderizar.
- Then ela redireciona para conclusão/reparo de acesso e não mostra dados protegidos.

### RC-006 — Performance observável

- Given medição sem cache de navegador para página protegida representativa.
- When usuário autenticado com vínculo preparado abre a página.
- Then p95 de utilizabilidade fica até 300 ms, com 150–250 ms como alvo de qualidade.

## Evidence format

A implementação deve registrar no PR quais testes, mocks ou instrumentação cobrem cada check. Se algum check depender de medição manual, o quickstart deve indicar comando, conta/cenário e métrica observada.

## Evidence map (implementação)

Mapa RC → cobertura desta implementação (T030), a ser colado no corpo do PR:

| Check | Cobertura |
|-------|-----------|
| RC-001 (dedup por request) | `frontend/src/lib/__tests__/auth-request-dedup.test.ts` (minimalidade por resolução) + instrumentação opt-in `AUTH_RESOLVE_DEBUG` em `resolveAuth`. A dedup cross-call é garantia de runtime do `cache()` do React, não reproduzível em unit test fora do request scope RSC. |
| RC-002 (sem lookup remoto por leitura) | `frontend/src/lib/__tests__/auth-no-remote-lookup.test.ts` (teto de lookups no caminho preparado) + gate estrutural `no-legacy-token-path.test.ts` (layouts só via `resolveAuth`). |
| RC-003 (caminho oficial Clerk/JWT/RLS) | `no-legacy-token-path.test.ts` (auth.ts sem `syncClerkUserToSupabase` no render) + `project-access-context.test.ts` (leitura de projeto por RLS). |
| RC-004 (sem token customizado legado) | `no-legacy-token-path.test.ts` (rota `/api/debug-token` removida e travada como ausente). |
| RC-005 (fail-closed) | `frontend/src/lib/__tests__/auth-fail-closed.test.ts`. |
| RC-006 (performance) | Medição manual — ver "Métrica de RC-006" abaixo e o `quickstart.md`. |

### Métrica de RC-006 / SC-001 (definição — M2)

"Utilizável" é medido como **latência do servidor até o conteúdo protegido ficar interativo** (TTFB → first-contentful/interactive do conteúdo protegido), sem cache de navegador, no p95 de uma página de projeto representativa. Alvo 150–250 ms, teto 300 ms. Essa métrica isola a contribuição da autenticação e **não substitui** os budgets de página da constituição (Princípio II: LCP < 2,5 s) — os dois convivem. Registrar no PR o comando/cenário e o número observado.

## FR-013 — gate de contingência de token não-padrão (T032)

Um caminho de token emitido localmente (fora da integração oficial Clerk/Supabase) **não faz parte da solução padrão**. Ele só pode ser considerado se, e somente se: (1) o caminho oficial for **medido** e falhar o alvo de SC-001/RC-006; **e** (2) passar por **revisão de segurança explícita** antes de qualquer implementação. Enquanto essas duas condições não forem satisfeitas e registradas, o gate `no-legacy-token-path.test.ts` (RC-004) trava a reintrodução silenciosa de qualquer caminho de token legado.
