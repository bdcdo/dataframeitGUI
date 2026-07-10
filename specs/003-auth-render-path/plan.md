# Implementation Plan: Caminho de autenticação rápido e recuperável

**Branch**: `003-auth-render-path` | **Date**: 2026-07-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-auth-render-path/spec.md`

## Summary

Reduzir a latência de páginas protegidas causada por resolução repetida de autenticação, preservando Clerk + Supabase/RLS como caminho oficial, distinguindo estados de acesso recuperáveis e mantendo papéis, aliases e `viewAs` sem ampliar permissões. A abordagem técnica é consolidar resolução de identidade e contexto de projeto como dados request-scoped, separar conclusão/reparo de vínculo do render protegido e exigir checks de regressão para impedir retorno de lookup remoto repetido, token customizado legado ou bypass privilegiado de RLS.

## Technical Context

**Language/Version**: TypeScript 5.7, React 19, Next.js 16 App Router; Python/FastAPI apenas fora do escopo ordinário desta feature, salvo se algum reparo backend específico for necessário.

**Primary Dependencies**: Clerk (`@clerk/nextjs`, `@clerk/localizations`), Supabase (`@supabase/supabase-js`), React Server Components, Server Actions, shadcn/ui, Tailwind CSS v4, Vitest.

**Storage**: Supabase Postgres com RLS via JWT Clerk/Supabase; tabelas relevantes incluem `profiles`, `master_users`, `clerk_user_mapping`, `projects`, `project_members` e `member_email_links`.

**Testing**: Vitest para helpers frontend e regressões de auth/autorização; testes manuais guiados pelo quickstart para render path, papéis e performance; pytest somente se backend FastAPI for alterado.

**Target Platform**: Web app desktop-first acessado por navegador em computador.

**Project Type**: Next.js frontend com App Router, RSC para reads, Server Actions para mutations e Supabase como camada de dados protegida por RLS.

**Performance Goals**: Usuário autenticado com vínculo preparado deve conseguir usar páginas protegidas em até 300 ms p95 sem cache de navegador, com 150–250 ms como alvo; identidade autenticada deve ser resolvida uma vez por request protegida representativa.

**Constraints**: Manter Clerk como provedor de login; manter Supabase/RLS como boundary de dados; não expor service key ao browser; não usar service key como caminho ordinário de páginas protegidas; não introduzir token customizado sem medição prévia e revisão de segurança; não fazer reparo silencioso de vínculo dentro do render protegido.

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
│   │   └── auth/
│   ├── lib/
│   │   ├── auth.ts
│   │   ├── clerk-sync.ts
│   │   └── supabase/server.ts
│   ├── actions/
│   └── components/
└── supabase/
    └── migrations/
```

**Structure Decision**: A implementação deve ficar no frontend Next.js, porque o problema ocorre no render path autenticado e nos helpers server-side de Clerk/Supabase. O backend FastAPI permanece fora do escopo salvo se uma evidência futura mostrar dependência direta de LLM/Pydantic, o que não é indicado pela spec atual.

## Phase 0 — Research

Research completed in [research.md](./research.md).

Decisions recorded:

1. `getAuthUser()` permanece como ponto único request-scoped de resolução da identidade autenticada.
2. Clerk + JWT Supabase + RLS continuam sendo o caminho oficial padrão.
3. Vínculo ausente ou divergente redireciona para conclusão/reparo, sem reparo silencioso no render protegido.
4. Estados signed out, link pendente, sem projeto e falha técnica são distinguíveis.
5. `getProjectAccessContext()` e `resolveEffectiveUserId()` preservam autorização por projeto, aliases e `viewAs`.
6. Regressões de lookup remoto repetido e token customizado legado precisam de check explícito.
7. Preparação/reparo de vínculo precisa ser idempotente.

## Phase 1 — Design

Design artifacts generated:

- [data-model.md](./data-model.md)
- [quickstart.md](./quickstart.md)
- [contracts/auth-resolution.md](./contracts/auth-resolution.md)
- [contracts/access-completion.md](./contracts/access-completion.md)
- [contracts/project-access.md](./contracts/project-access.md)
- [contracts/regression-checks.md](./contracts/regression-checks.md)

### Implementation guidance for `/speckit-tasks`

- Reuse `frontend/src/lib/auth.ts` as the primary seam: `getAuthUser()`, `getEffectiveMemberId()`, `resolveEffectiveUserId()` and `getProjectAccessContext()` already encode most of the intended separation.
- Reuse `frontend/src/lib/supabase/server.ts` for the official Clerk/Supabase JWT path; do not replace ordinary protected reads with `createSupabaseAdmin()`.
- Preserve `frontend/src/lib/clerk-sync.ts` idempotence patterns when moving or isolating link completion/recovery.
- Introduce any user-facing completion UI under `frontend/src/app/auth/` or an equivalent auth route, using pt-BR and shadcn/ui patterns.
- Tests should focus on pure resolution and authorization helpers first, then add integration/regression coverage around layouts and access states.

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
