# Implementation Plan: Pré-registro de membros sem conta e vínculo de múltiplos e-mails

**Branch**: `002-preregister-members` | **Date**: 2026-06-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-preregister-members/spec.md`

## Summary

Coordenadores passam a poder (1) adicionar e-mails sem conta a um projeto — o membro nasce "pendente", já elegível para atribuições, e entra automaticamente no primeiro acesso (sem e-mail transacional) — e (2) vincular e-mails adicionais a um membro, com efeito restrito ao projeto: qualquer e-mail vinculado acessa como o mesmo membro, com atribuições unificadas. Abordagem técnica: placeholder Supabase-only no pré-registro (remove a criação de usuário Clerk do `addMember`), coluna `profiles.activated_at` para o status pendente, tabela `member_email_links` como registro de vínculo + alias único por conta/projeto, RLS com precedência da identidade canônica, `getProjectAccessContext` como contrato público de páginas e unificação de membros via função Postgres transacional `unify_project_members` (RPC). Decisões detalhadas em [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.7 (Next.js 16 App Router, React 19); SQL (Postgres/Supabase). Backend FastAPI não é tocado.

**Primary Dependencies**: `@clerk/nextjs` (auth + webhook svix), `@supabase/supabase-js` (server + admin clients), shadcn/ui, sonner.

**Storage**: Supabase Postgres com RLS via Clerk JWT (`clerk_uid()` lê claim `supabase_uid`). Migrations em `frontend/supabase/migrations/`, aplicadas manualmente com `npx supabase db push`.

**Testing**: Vitest (frontend) para utils puros e contratos das actions; validação manual via quickstart.md (fluxo de signup real não é automatizável localmente sem Clerk E2E).

**Target Platform**: Web desktop (densidade > toque, conforme CLAUDE.md).

**Project Type**: Web app (frontend Next.js + Supabase; FastAPI só para LLM, fora do escopo).

**Performance Goals**: lista de membros e resolução de identidade efetiva sem queries N+1; funções RLS novas com index em `member_email_links.linked_user_id`.

**Constraints**: RLS continua a barreira de leitura e de mutations associadas a linhas do projeto; RPCs transacionais derivam o projeto da linha autorizada, enquanto operações que precisam de admin client só o usam em server actions após checagem canônica de coordenador; nenhuma quebra do fluxo atual de membros com conta.

**Scale/Scope**: dezenas de membros por projeto; unificação é operação rara (transação pequena). ~6 actions, 1 tabela nova, 1 coluna nova, 2-3 funções RLS, UI da tela de membros.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` é o template não ratificado — sem gates formais. Gates de fato adotados (CLAUDE.md do projeto):

- ✅ Server Actions para mutations, RSC para reads — todas as operações novas são actions em `actions/members.ts`.
- ✅ Queries com colunas explícitas, sem `select("*")`; agregações via `count`/join; `Promise.all` para independentes.
- ✅ Tabela nova em RLS com index nas colunas usadas pelas funções de auth (`linked_user_id`, `project_id`).
- ✅ UI com shadcn/ui, pt-BR nos labels, código em inglês.
- ✅ Migrations manuais (memória do projeto): `db push` nunca roda sozinho no merge.
- ✅ Pydantic/schema não é tocado — regras de round-trip não se aplicam.

**Pós-Phase 1**: sem violações; nenhuma entrada em Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-preregister-members/
├── plan.md              # Este arquivo
├── research.md          # Decisões D1–D6
├── data-model.md        # profiles.activated_at, member_email_links, RLS, unify_project_members
├── quickstart.md        # Roteiro de validação manual
├── contracts/
│   └── server-actions.md  # Contratos das actions + webhook
└── tasks.md             # (/speckit-tasks — não criado por este comando)
```

### Source Code (repository root)

```text
frontend/
├── supabase/migrations/
│   └── 2026MMDDHHMMSS_preregister_and_email_links.sql   # activated_at + member_email_links + RLS + unify RPC
└── src/
    ├── actions/
    │   ├── members.ts            # addMember (placeholder sem Clerk), removeMember via RPC atômica, novas: updatePendingMemberEmail, linkMemberEmail, unifyMembers, unlinkMemberEmail
    │   ├── responses.ts          # respondent_id → identidade canônica do membro
    │   └── field-reviews.ts      # self/arbitrator → identidade canônica do membro
    ├── app/
    │   ├── api/webhooks/clerk/route.ts            # ativação + resolução de vínculos no user.created
    │   └── (app)/projects/[id]/
    │       ├── layout.tsx                         # porta pública do contexto de acesso canônico
    │       ├── config/members/page.tsx            # query inclui activated_at + links
    │       └── analyze/code/page.tsx              # consome memberUserId; impersonação master é separada
    ├── components/members/
    │   ├── MemberList.tsx        # badge Pendente, e-mails vinculados, ações de editar/vincular/desvincular
    │   ├── AddMemberDialog.tsx   # toast "pré-registrado" (sem promessa de e-mail)
    │   ├── LinkEmailDialog.tsx   # novo
    │   └── UnifyMembersDialog.tsx # novo (confirmação com preview)
    └── lib/
        ├── auth.ts               # autenticação read-only + contexto de acesso canônico
        ├── clerk-sync.ts         # sincronização e ativação idempotentes fora do render path
        └── types.ts              # Profile.activated_at, MemberEmailLink
```

**Structure Decision**: tudo no frontend Next.js + migrations Supabase, seguindo a arquitetura existente (FastAPI não participa de CRUD). A mecânica nova concentra-se em `actions/members.ts`, `lib/auth.ts` e uma migration; o restante são pontos de adoção do contexto canônico e UI da tela de membros.

## Fases

**Phase 0 (research)**: concluída — [research.md](./research.md) com D1 (placeholder sem Clerk), D2 (`activated_at`), D3 (alias por projeto), D4 (RPC transacional), D5 (sorteio inalterado), D6 (remoção libera atribuições).

**Phase 1 (design & contracts)**: concluída — [data-model.md](./data-model.md), [contracts/server-actions.md](./contracts/server-actions.md), [quickstart.md](./quickstart.md); contexto do agente atualizado no `CLAUDE.md` (markers SPECKIT).

**Ordem sugerida para /speckit-tasks**: migration + types → US1 (addMember/placeholder, webhook/ativação, badge pendente, editar/remover) → US2 (links: action + dialog + RLS/effective id) → unificação (RPC + preview + dialog) → testes Vitest + quickstart.

## Riscos e atenções

- **RLS de "own rows"**: trocar `= clerk_uid()` por `IN (auth_user_member_identity_ids(project_id))` em `responses`/`reviews`/`field_reviews` exige conferir cada policy existente — erro aqui vira vazamento ou bloqueio. Testar com conta vinculada e conta alheia.
- **Colisões na unificação**: `UNIQUE(document_id, user_id, type)` em assignments e `is_latest` em responses são os dois pontos com lógica não trivial — cobertos na função SQL, com preview honesto no dialog (FR-009/FR-010).
- **Backfill de `activated_at`**: convidados antigos nunca-logados ficarão como "ativos" (limitação aceita, research D2).
- **Compatibilidade**: o caminho "e-mail com conta existente" do `addMember` e todo o fluxo de quem já é membro permanecem intactos; placeholder novo não cria usuário Clerk, então o workaround do Turnstile (members.ts:55-66) sai junto.
