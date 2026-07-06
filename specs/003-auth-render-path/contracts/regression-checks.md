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
