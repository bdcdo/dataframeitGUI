# Implementation Plan: Caminho de autenticação rápido e recuperável

**Branch**: `003-auth-render-path` | **Date**: 2026-07-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-auth-render-path/spec.md`

## Summary

Reduzir a latência de páginas protegidas causada por resolução repetida de autenticação, preservando Clerk + Supabase/RLS como caminho oficial, distinguindo estados recuperáveis e mantendo papéis, aliases e `viewAs` sem ampliar permissões. `resolveAuth()` e o contexto de projeto são request-scoped e read-only; webhook e `completeAccess()` relêem o estado atual do Clerk e executam um snapshot de duas fases, no qual a primeira transação invalida o marker anterior e escolhe a geração e a segunda aplica profile, aliases e marker final atomicamente. `user.deleted`, 404 e ausência de primário verificado falham fechados.

## Technical Context

**Language/Version**: TypeScript 6, React 19.2, Next.js 16.2 App Router; Python/FastAPI permanece fora do escopo desta feature.

**Primary Dependencies**: Clerk (`@clerk/nextjs`, `@clerk/localizations`), Supabase (`@supabase/supabase-js`), React Server Components, Server Actions, shadcn/ui, Tailwind CSS v4, Vitest.

**Storage**: Supabase Postgres com RLS via JWT Clerk/Supabase; `clerk_user_mapping` persiste `access_sync_version`, `access_snapshot_version` e `clerk_deleted`, referencia `profiles(id) ON DELETE CASCADE` e ancora a validação atual do claim. Migrations são validadas localmente e aplicadas remotamente somente por operação manual separada.

**Testing**: Vitest em `frontend/src/lib/__tests__/`, `frontend/src/actions/__tests__/`, `frontend/src/app/auth/__tests__/` e testes de layouts/dashboard; testes SQL locais em `frontend/supabase/tests/`; quickstart manual para Clerk real, papéis e performance.

**Target Platform**: Web app desktop-first acessado por navegador em computador.

**Project Type**: Next.js frontend com App Router, RSC para reads, Server Actions para mutations e Supabase como camada de dados protegida por RLS.

**Performance Goals**: Usuário autenticado com vínculo preparado deve conseguir usar páginas protegidas em até 300 ms p95 sem cache de navegador, com 150–250 ms como alvo; identidade autenticada deve ser resolvida uma vez por request protegida representativa.

**Constraints**: Manter Clerk como autoridade atual de login e e-mails; manter Supabase/RLS como boundary de dados; não expor service key ao browser nem usá-la como caminho ordinário; não introduzir token customizado sem medição e revisão de segurança; não reparar vínculo no render; não aceitar metadata, profile por e-mail ou webhook antigo como prova isolada; não aplicar migration remota automaticamente neste fluxo.

**Scale/Scope**: Dashboard, layouts protegidos, páginas de projeto, filas pessoais e fluxos de leitura com múltiplas consultas na mesma request. Deve cobrir coordenadores, pesquisadores diretos, pesquisadores por e-mail alternativo, master users, `viewAs` e usuários sem acesso.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-research gate

| Principle | Assessment |
|-----------|------------|
| I. Usabilidade primeiro | PASS — a feature exige estados claros de conclusão/reparo em pt-BR e diferencia sessão ausente, link pendente, ausência de projeto e falha técnica. |
| II. Velocidade | PASS — o objetivo central é remover trabalho repetido de autenticação do caminho crítico e medir p95 de páginas protegidas. |
| III. Segurança da informação | PASS — o plano mantém least privilege, proíbe service key no browser e rejeita caminho privilegiado ordinário. |
| IV. RLS-por-padrão | PASS — dados protegidos continuam passando por Clerk + JWT Supabase + policies RLS. |
| V. Robustez via testes | PASS — a feature exige regressões Vitest e quickstart com evidência de performance/autorização. |
| VI. Acessibilidade WCAG 2.1 AA | PASS — a tela de conclusão/reparo precisa ser navegável por teclado, com foco visível, labels e contraste AA. |
| VII. Fonte única de verdade do schema | N/A — a feature não altera schema de codificação Pydantic. |
| VIII. Simplicidade de stack | PASS — nenhuma tecnologia nova é necessária; a solução reutiliza helpers e padrões existentes. |

No constitutional violations identified. Complexity Tracking remains empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-auth-render-path/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── access-completion.md
│   ├── auth-resolution.md
│   ├── project-access.md
│   └── regression-checks.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
frontend/
├── src/
│   ├── app/
│   │   ├── (app)/layout.tsx
│   │   ├── (app)/projects/[id]/layout.tsx
│   │   ├── (app)/dashboard/__tests__/page.test.tsx
│   │   ├── api/webhooks/clerk/route.ts
│   │   └── auth/post-login/page.tsx
│   ├── lib/
│   │   ├── auth.ts
│   │   ├── clerk-primary-email.ts
│   │   ├── clerk-sync.ts
│   │   ├── project-access.ts
│   │   └── supabase/server.ts
│   ├── actions/
│   │   └── complete-access.ts
│   └── components/
│       └── auth/AccessCompletionCard.tsx
└── supabase/
    ├── migrations/20260715173000_canonical_project_identity_rls.sql
    └── tests/clerk_mapping_completion.test.sql
```

**Structure Decision**: A implementação deve ficar no frontend Next.js, porque o problema ocorre no render path autenticado e nos helpers server-side de Clerk/Supabase. O backend FastAPI permanece fora do escopo salvo se uma evidência futura mostrar dependência direta de LLM/Pydantic, o que não é indicado pela spec atual.

## Phase 0 — Research

Research completed in [research.md](./research.md).

Decisions recorded:

1. `resolveAuth()` é a fonte discriminada request-scoped; `getAuthUser()` é apenas sua projeção autenticada/null.
2. Clerk + JWT Supabase + RLS continuam sendo o caminho oficial padrão.
3. Vínculo ausente ou divergente redireciona para conclusão/reparo, sem reparo silencioso no render protegido.
4. Estados signed out, link pendente, sem projeto e falha técnica são distinguíveis.
5. `getProjectAccessContext(projectId, user)` preserva conta real e membro canônico; `resolveProjectQueueIdentity(access, viewAsUser)` aplica a precedência de fila e `viewAs`.
6. Regressões de lookup remoto repetido e token customizado legado precisam de check explícito.
7. Preparação/reparo de vínculo precisa ser idempotente.
8. O estado atual do Clerk é autoridade; ausência de primário e remoção de conta revogam acesso.
9. O snapshot em duas fases e sua geração impedem restauração por evento antigo.
10. `profileByEmail` administrativo e `ownerProfile` verificado são identidades distintas.

## Phase 1 — Design

Design artifacts generated:

- [data-model.md](./data-model.md)
- [quickstart.md](./quickstart.md)
- [contracts/auth-resolution.md](./contracts/auth-resolution.md)
- [contracts/access-completion.md](./contracts/access-completion.md)
- [contracts/project-access.md](./contracts/project-access.md)
- [contracts/regression-checks.md](./contracts/regression-checks.md)

### Implementation guidance for `/speckit-tasks`

- Reuse `frontend/src/lib/auth.ts` as the primary seam: `resolveAuth()`/`getAuthUser()` resolve the session, `getProjectAccessContext(projectId, user)` serves pages and layouts, `resolveProjectMemberActor(projectId)` is the only personal-mutation gate, and `resolveProjectQueueIdentity(access, viewAsUser)` affects only the viewed queue.
- Reuse `frontend/src/lib/supabase/server.ts` for the official Clerk/Supabase JWT path; do not replace ordinary protected reads with `createSupabaseAdmin()`.
- Preserve o protocolo de `frontend/src/lib/clerk-sync.ts`: primário verificado por `clerk-primary-email.ts`, geração `User.updatedAt`, `begin_*` antes de `complete_*`, metadata por último e revogação explícita para `user.deleted`/404.
- Introduce any user-facing completion UI under `frontend/src/app/auth/` or an equivalent auth route, using pt-BR and shadcn/ui patterns.
- Tests should cover `auth-fail-closed.test.ts`, `auth-effective-member.test.ts`, `clerk-primary-email.test.ts`, `clerk-sync.test.ts`, `complete-access.test.ts`, access-completion UI, `project-access.test.ts`, `viewas-no-write.test.ts` and the structural gate `no-legacy-token-path.test.ts`.

## Constitution Check — Post-design

| Principle | Assessment |
|-----------|------------|
| I. Usabilidade primeiro | PASS — `access-completion` defines non-technical pt-BR states and retry behavior. |
| II. Velocidade | PASS — `regression-checks` defines request deduplication and p95 evidence. |
| III. Segurança da informação | PASS — contracts reject service-key bypass and token/debug exposure. |
| IV. RLS-por-padrão | PASS — `project-access` and `auth-resolution` keep JWT/RLS as ordinary boundary. |
| V. Robustez via testes | PASS — quickstart and contracts enumerate required regression tests. |
| VI. Acessibilidade WCAG 2.1 AA | PASS — completion state includes keyboard, focus, labels and contrast requirements. |
| VII. Fonte única de verdade do schema | N/A — no Pydantic schema change. |
| VIII. Simplicidade de stack | PASS — design reuses existing Next.js/Clerk/Supabase helpers and adds no stack layer. |

No constitutional violations remain after design.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|

No entries — the design does not require constitutional exceptions.
