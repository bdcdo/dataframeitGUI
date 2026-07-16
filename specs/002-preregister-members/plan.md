# Implementation Plan: Pré-registro de membros sem conta e vínculo de múltiplos e-mails

**Branch**: `002-preregister-members` | **Date**: 2026-06-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-preregister-members/spec.md`

## Summary

Coordenadores passam a poder (1) adicionar e-mails sem conta a um projeto — o membro nasce "pendente", já elegível para atribuições, e entra automaticamente quando o Clerk confirma o primeiro acesso — e (2) vincular e-mails adicionais a um membro, com efeito restrito ao projeto. O desenho usa placeholder Supabase-only, `profiles.activated_at`, `member_email_links`, identidade terminal no schema, RLS canônica e `unify_project_members`; a posse atual verificada no Clerk é a autoridade para resolver aliases. A reconciliação usa snapshot em duas fases: a primeira escolhe a geração Clerk e invalida o marker anterior; a segunda aplica profile, aliases e marker de conclusão atomicamente, antes de publicar metadata. Decisões detalhadas em [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 6, Next.js 16.2 App Router e React 19.2; SQL (Postgres/Supabase). Backend FastAPI não é tocado.

**Primary Dependencies**: `@clerk/nextjs` (auth + webhook svix), `@supabase/supabase-js` (server + admin clients), shadcn/ui, sonner.

**Storage**: Supabase Postgres com RLS via Clerk JWT (`clerk_uid()` lê claim `supabase_uid`). Migrations em `frontend/supabase/migrations/`, validadas localmente e aplicadas ao ambiente remoto somente em operação manual separada deste fluxo.

**Testing**: Vitest para actions, autenticação, reconciliação Clerk, utilitários e diálogos; testes SQL locais para constraints, RLS, snapshots e unificação; validação manual via quickstart.md para o fluxo real do Clerk.

**Target Platform**: Web desktop (densidade > toque, conforme CLAUDE.md).

**Project Type**: Web app (frontend Next.js + Supabase; FastAPI só para LLM, fora do escopo).

**Performance Goals**: lista de membros e resolução de identidade efetiva sem queries N+1; funções RLS novas com index em `member_email_links.linked_user_id`.

**Constraints**: RLS continua a barreira de leitura e de mutations associadas a linhas do projeto; RPCs transacionais derivam o projeto da linha autorizada, enquanto operações que precisam de admin client só o usam em server actions após checagem canônica de coordenador; o estado atual verificado no Clerk prevalece sobre coincidências locais de e-mail; a aplicação remota de migrations é uma operação manual separada e nunca um comando automático deste fluxo.

**Scale/Scope**: dezenas de membros por projeto; unificação é operação rara. O escopo inclui actions de membros, reconciliação Clerk, contexto canônico, migrations incrementais, testes SQL/Vitest e UI da tela de membros.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` é o template não ratificado — sem gates formais. Gates de fato adotados (CLAUDE.md do projeto):

- ✅ Server Actions para mutations, RSC para reads — todas as operações novas são actions em `actions/members.ts`.
- ✅ Queries com colunas explícitas, sem `select("*")`; agregações via `count`/join; `Promise.all` para independentes.
- ✅ Tabela nova em RLS com index nas colunas usadas pelas funções de auth (`linked_user_id`, `project_id`).
- ✅ UI com shadcn/ui, pt-BR nos labels, código em inglês.
- ✅ Migrations são validadas localmente e aplicadas ao ambiente remoto somente por operação manual separada; nenhum comando de publicação de schema faz parte do merge ou desta revisão.
- ✅ Pydantic/schema não é tocado — regras de round-trip não se aplicam.

**Pós-Phase 1**: sem violações; nenhuma entrada em Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-preregister-members/
├── plan.md              # Este arquivo
├── research.md          # Decisões D1–D8
├── data-model.md        # profiles.activated_at, member_email_links, RLS, unify_project_members
├── quickstart.md        # Roteiro de validação manual
├── contracts/
│   └── server-actions.md  # Contratos das actions + webhook
└── tasks.md             # (/speckit-tasks — não criado por este comando)
```

### Source Code (repository root)

```text
frontend/
├── supabase/
│   ├── migrations/
│   │   ├── 20260611120000_profiles_activated_at.sql
│   │   ├── 20260611130000_member_email_links.sql
│   │   ├── 20260611140000_unify_project_members.sql
│   │   ├── 20260611150000_review_fixes_alias_unify.sql
│   │   └── 20260716160000_canonical_project_identity_rls.sql
│   └── tests/             # identidade canônica, mapping/snapshot, RLS e RPCs
└── src/
    ├── actions/
    │   ├── members.ts            # addMember (placeholder sem Clerk), removeMember via RPC atômica, novas: updatePendingMemberEmail, linkMemberEmail, unifyMembers, unlinkMemberEmail
    │   ├── responses.ts          # respondent_id → identidade canônica do membro
    │   └── field-reviews.ts      # self/arbitrator → identidade canônica do membro
    ├── app/
    │   ├── api/webhooks/clerk/route.ts            # user.created/user.updated reconciliam; user.deleted revoga
    │   └── (app)/projects/[id]/
    │       ├── layout.tsx                         # porta pública do contexto de acesso canônico
    │       ├── config/members/page.tsx            # query inclui activated_at + links
    │       └── analyze/code/page.tsx              # consome memberUserId; impersonação master é separada
    ├── components/members/
    │   ├── MemberList.tsx        # badge Pendente, e-mails vinculados, ações de editar/vincular/desvincular
    │   ├── AddMemberDialog.tsx   # toast "pré-registrado" (sem promessa de e-mail)
    │   ├── LinkEmailDialog.tsx   # novo
    │   ├── UnifyMembersDialog.tsx # confirmação com preview e linkEmail
    │   └── __tests__/             # dialogs e status ativo derivado por alias
    └── lib/
        ├── auth.ts               # autenticação read-only + contexto de acesso + gate canônico de mutations pessoais
        ├── clerk-primary-email.ts # primário e endereços verificados do Clerk
        ├── clerk-sync.ts         # snapshot em duas fases, ativação e revogação fora do render
        ├── __tests__/clerk-sync.test.ts
        ├── __tests__/clerk-primary-email.test.ts
        └── types.ts              # Profile.activated_at, MemberEmailLink
```

**Structure Decision**: tudo fica no frontend Next.js e nas migrations Supabase existentes; o FastAPI não participa do CRUD. Actions administrativas, reconciliação de identidade, invariantes SQL, contexto canônico e UI mantêm responsabilidades separadas, sem uma camada adicional.

## Fases

**Phase 0 (research)**: concluída — [research.md](./research.md) com D1–D8, incluindo placeholder sem Clerk, ativação, alias terminal, unificação, sorteio, remoção por cascade, snapshot/revogação Clerk e separação entre lookup administrativo e dono atual.

**Phase 1 (design & contracts)**: concluída — [data-model.md](./data-model.md), [contracts/server-actions.md](./contracts/server-actions.md), [quickstart.md](./quickstart.md); contexto do agente atualizado no `CLAUDE.md` (markers SPECKIT).

**Ordem sugerida para /speckit-tasks**: migrations + types → US1 (placeholder, reconciliação, ativação, badge, editar/remover) → US2 (links, contexto canônico e RLS) → unificação (RPC + preview + `linkEmail`) → hardening de snapshot/revogação → testes SQL/Vitest + quickstart.

## Riscos e atenções

- **RLS de "own rows"**: trocar `= clerk_uid()` por `IN (auth_user_member_identity_ids(project_id))` em `responses`/`reviews`/`field_reviews` exige conferir cada policy existente — erro aqui vira vazamento ou bloqueio. Testar com conta vinculada e conta alheia.
- **Colisões na unificação**: `UNIQUE(document_id, user_id, type)` em assignments e `is_latest` em responses exigem tratamento transacional; reviews concorrentes do mesmo campo não admitem escolha implícita, então `reviewConflicts` bloqueia o diálogo e a RPC aborta sob lock para preservar ambas (FR-009/FR-010).
- **Backfill de `activated_at`**: convidados antigos nunca-logados ficarão como "ativos" (limitação aceita, research D2).
- **Compatibilidade**: a UI de adicionar conta existente permanece, mas `addMember` usa o dono atual verificado no Clerk e falha fechado diante de profile ativo sem posse confirmada; placeholder novo não cria usuário Clerk.
- **Eventos Clerk fora de ordem**: `access_snapshot_version` usa `user.updatedAt` como geração; a fase de conclusão só aceita a geração escolhida, e `clerk_deleted` impede que um Clerk ID removido seja reativado por evento antigo.
- **Concorrência durante a migration**: a aplicação remota manual deve pausar novas reconciliações Clerk e operações de vínculo/unificação, aguardar as transações em curso e só então aplicar a migration transacional. Se houver timeout de lock ou deadlock com uma operação antiga, o procedimento deve deixar a transação abortar e repetir a migration inteira depois de drenar as mutations; não se continua a partir de um estado parcial.
