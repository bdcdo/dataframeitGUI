# Tasks: Pré-registro de membros sem conta e vínculo de múltiplos e-mails

**Input**: Design documents from `/specs/002-preregister-members/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D8), data-model.md, contracts/server-actions.md, quickstart.md

**Tests**: incluídos de forma seletiva (utils puros e contratos críticos via Vitest, conforme plan.md); validação de fluxo com signup real é manual via quickstart.md.

**Organization**: tarefas agrupadas por user story; US1 (pré-registro) é o MVP e não depende de US2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: paralelizável (arquivos distintos, sem dependência pendente)
- **[US1/US2]**: user story da spec.md

## Phase 1: Setup

**Purpose**: garantir ambiente pronto para migrations (memória do projeto: migrations são manuais, nunca automáticas no merge)

- [X] T001 Conferir Supabase CLI linkado e estado das migrations: `cd frontend && export SUPABASE_ACCESS_TOKEN=$(grep SUPABASE_ACCESS_TOKEN .env.local | cut -d= -f2) && npx supabase link --project-ref nryebmwlmxuwvynfuzsv && npx supabase migration list`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: coluna de ativação e tipos — pré-requisito das duas stories

**⚠️ CRITICAL**: nenhuma story começa antes desta fase

- [X] T002 Migration `frontend/supabase/migrations/20260611120000_profiles_activated_at.sql`: `ALTER TABLE profiles ADD COLUMN activated_at TIMESTAMPTZ` + backfill `UPDATE profiles SET activated_at = created_at` (data-model.md §profiles); validar no banco local e deixar a aplicação remota para a operação manual separada
- [X] T003 [P] Adicionar `activated_at: string | null` ao tipo `Profile` em `frontend/src/lib/types.ts`

**Checkpoint**: coluna existe no banco remoto; tipos compilam

---

## Phase 3: User Story 1 - Pré-registrar pessoa sem conta no projeto (Priority: P1) 🎯 MVP

**Goal**: coordenador adiciona e-mail sem conta → membro "pendente" elegível para atribuições; auto-join no primeiro acesso; correção/remoção de pendentes.

**Independent Test**: quickstart.md §US1 — pré-registrar e-mail virgem, atribuir documentos, criar conta com o e-mail e verificar projeto + atribuições no primeiro acesso (badge some).

### Implementation for User Story 1

- [X] T004 [US1] Criar helper `preregisterSupabaseUser(email): Promise<string>` em `frontend/src/lib/clerk-sync.ts`: cria `auth.users` (admin, email_confirm) + `profiles` com `activated_at = NULL`, idempotente para e-mail já existente (research D1)
- [X] T005 [US1] Refatorar `addMember` em `frontend/src/actions/members.ts`: validar formato do e-mail + normalizar lowercase (FR-006); trocar criação de usuário Clerk (linhas 51-80, incl. workaround Turnstile) por `preregisterSupabaseUser`; retornar `{ pending: true }` no lugar de `invited` (contracts §addMember)
- [X] T006 [P] [US1] Webhooks `user.created`/`user.updated`/`user.deleted` em `frontend/src/app/api/webhooks/clerk/route.ts`: reconciliar somente a identidade cujo e-mail primário está verificado; revogar marker e aliases quando não houver primário útil ou a conta for removida (FR-004/FR-016/SC-005)
- [X] T007 [P] [US1] Manter `getAuthUser()` read-only e fail-closed; a tela de conclusão chama `completeAccess()` para reparar mapping, marker e metadata sem mutação no render protegido (research D2/D7)
- [X] T008 [US1] Nova action `updatePendingMemberEmail(projectId, memberUserId, newEmail)` em `frontend/src/actions/members.ts`: só para profile reclamável; atualiza `auth.users` pela Auth Admin API, e o trigger transacional sincroniza `profiles.email` sob a mesma trava do claim Clerk; efeito é global (FR-005) — retornar `otherProjectsCount` para a UI avisar quando o pendente pertence a outros projetos; erros do contrato (contracts §updatePendingMemberEmail)
- [X] T009 [US1] `removeMember` em `frontend/src/actions/members.ts`: deletar também `assignments` com `status = 'pendente'` do usuário no projeto (FR-005, research D6)
- [X] T010 [US1] Query da página `frontend/src/app/(app)/projects/[id]/config/members/page.tsx`: incluir `activated_at` no select do join `profiles` (colunas explícitas)
- [X] T011 [US1] `frontend/src/components/members/MemberList.tsx`: badge "Pendente" (shadcn Badge) para `activated_at === null` + ação "Corrigir e-mail" (visível só em pendentes) chamando `updatePendingMemberEmail` com aviso quando `otherProjectsCount > 0`; aplicar o mesmo badge na seleção de pesquisadores do sorteio em `frontend/src/components/assignments/LotteryDialog.tsx` (research D5)
- [X] T012 [P] [US1] `frontend/src/components/members/AddMemberDialog.tsx`: toast para `pending: true` — "Membro pré-registrado. Ele entrará no projeto ao criar conta com este e-mail." (sem promessa de envio de e-mail)
- [X] T013 [US1] Testes Vitest em `frontend/src/actions/__tests__/members.test.ts` (arquivo existente): validação/normalização de e-mail do `addMember` e idempotência do `preregisterSupabaseUser` (mock do admin client)
- [ ] T014 [US1] Validar quickstart.md §US1 (passos 1–5) no ambiente real

**Checkpoint**: US1 completa e testável de ponta a ponta — MVP entregável

---

## Phase 4: User Story 2 - Vincular mais de um e-mail ao mesmo pesquisador (Priority: P2)

**Goal**: coordenador vincula e-mails adicionais; a conta que comprova no Clerk a posse atual de um endereço vinculado acessa o projeto como o mesmo membro (atribuições unificadas); unificação confirmada quando o e-mail já é outro membro; desvínculo.

**Independent Test**: quickstart.md §US2 — vincular e-mail sem conta a um membro, criar conta com ele e verificar acesso como o mesmo membro; unificar dois membros e conferir soma de atribuições sem perda de respostas.

### Implementation for User Story 2

- [X] T015 [US2] Migration `frontend/supabase/migrations/20260611130000_member_email_links.sql`: tabela `member_email_links` + 3 indexes + policies (SELECT membros, mutação coordenadores) + estender `auth_user_accessible_project_ids()` + criar `auth_user_member_identity_ids(p_project_id)` + atualizar policies own-rows de `responses` (respondent_id), `reviews` (reviewer_id) e `field_reviews` (self_reviewer_id/arbitrator_id) conforme data-model.md §RLS; validar localmente, deixando a aplicação remota para operação manual separada
- [X] T016 [US2] Migration `frontend/supabase/migrations/20260611140000_unify_project_members.sql`: função `unify_project_members` SECURITY DEFINER com a tabela de migração de colunas e tratamento de colisões do data-model.md; validar localmente e deixar a aplicação remota para a operação manual separada
- [X] T017 [P] [US2] Tipo `MemberEmailLink` em `frontend/src/lib/types.ts` (campos da tabela)
- [X] T018 [US2] `resolveProjectMemberActor(projectId)` em `frontend/src/lib/auth.ts`: porta única das mutations pessoais que resolve `AuthUser` + `memberUserId` ou devolve falha discriminada `unauthenticated | identity_unavailable`
- [X] T019 [US2] Actions `linkMemberEmail` (retorno discriminado e preview SQL agregado com impacto e conflitos de review/arbitragem/comparação) e `unlinkMemberEmail` em `frontend/src/actions/members.ts`
- [X] T020 [US2] Action `unifyMembers(projectId, sourceUserId, targetUserId, linkEmail)` em `frontend/src/actions/members.ts`: checagem de coordenador, revalidação do e-mail vindo do preview, novo preview sob estado atual, RPC `unify_project_members` via admin e revalidação dos paths de members/assignments/compare
- [X] T021 [US2] Reconciliação compartilhada do webhook e `completeAccess()`, apoiada por `frontend/supabase/migrations/20260716155000_canonical_project_identity_rls.sql`: snapshot de duas fases com `access_snapshot_version`, aliases da lista completa de e-mails verificados, marker `access_sync_version` e metadata por último; ausência de primário e `user.deleted` revogam acesso; validar a migration localmente e aplicar remotamente apenas pela operação manual separada
- [X] T022 [US2] Adotar identidade canônica nos pontos de trabalho atuais: `frontend/src/app/(app)/projects/[id]/analyze/code/page.tsx`, layouts e filas de analyze/reviews, além de `frontend/src/actions/documents.ts`, `responses.ts`, `reviews.ts` e `field-reviews.ts`, compondo com `viewAsUser` somente para leitura
- [X] T023 [P] [US2] Novo `frontend/src/components/members/LinkEmailDialog.tsx`: input de e-mail + estados dos 4 casos do contrato (sucesso, requer unificação, e-mail já vinculado, erro)
- [X] T024 [P] [US2] Novo `frontend/src/components/members/UnifyMembersDialog.tsx`: confirmação explícita com o preview retornado por `linkMemberEmail` (FR-009) e aviso de permanência (clarificação Q1)
- [X] T025 [US2] `frontend/src/components/members/MemberList.tsx`: exibir e-mails vinculados por membro (FR-015) + ações vincular (abre LinkEmailDialog) e desvincular; a remoção da membership apaga `member_email_links` exclusivamente pelo `ON DELETE CASCADE` da FK composta, sem `DELETE` duplicado na action ou RPC
- [X] T026 [US2] Query da página `frontend/src/app/(app)/projects/[id]/config/members/page.tsx`: buscar `member_email_links` do projeto (colunas explícitas, `Promise.all` com a query de membros)
- [X] T027 [US2] Testes Vitest em `frontend/src/actions/__tests__/members.test.ts`, `frontend/src/lib/__tests__/auth-effective-member.test.ts`, `frontend/src/lib/__tests__/clerk-primary-email.test.ts`, `frontend/src/lib/__tests__/clerk-sync.test.ts` e `frontend/src/components/members/__tests__/`: matriz de `profileByEmail`/`ownerProfile`, snapshot/revogação, resolução canônica, preview, `linkEmail`, status ativo por alias e contratos dos diálogos
- [ ] T028 [US2] Validar quickstart.md §US2 (passos 1–5) no ambiente real, incluindo verificação RLS: conta vinculada acessa o projeto mas **não** os demais projetos do membro, e conta alheia não lê os links

**Checkpoint**: US1 e US2 funcionais e independentes

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T029 [P] Rodar react-doctor/lint no frontend e resolver diagnósticos introduzidos pela feature
- [X] T030 Revisão de performance das queries novas: colunas explícitas, sem N+1 na lista de membros e `resolveProjectMemberActor` request-scoped via `cache()`
- [ ] T031 Regressão manual: fluxo antigo de membro com conta existente (adicionar, trocar role, can_arbitrate/can_resolve, remover) permanece intacto; quickstart completo

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)** → **Foundational (P2)** → stories.
- **US1 (Phase 3)**: depende só da Foundational. Não usa `member_email_links`.
- **US2 (Phase 4)**: depende da Foundational; integra com US1 apenas na UI compartilhada (`MemberList.tsx`, página members) — implementável de forma independente após T002/T003, mas os toques de UI (T025/T026) assumem T010/T011 prontos.
- **Polish**: após as stories desejadas.

### Within Stories

- US1: T004 → T005 → (T006, T007, T012 em paralelo) → T008/T009 → T010 → T011 → T013 → T014.
- US2: T015 → T016 (migrations primeiro); T017/T018 → T019/T020/T021 → T022 → (T023, T024 em paralelo) → T025/T026 → T027 → T028.

### Parallel Opportunities

- T003 com T002 (arquivos distintos).
- US1: T006, T007 e T012 em paralelo após T005.
- US2: T017, T023 e T024 paralelizáveis; T021 paralelo a T019/T020.
- Com dois devs: após Phase 2, dev A toca US1 (actions/webhook/UI de pendência) enquanto dev B prepara migrations e RLS de US2 (T015/T016) — únicos arquivos compartilhados são `members.ts`, `MemberList.tsx` e a página members (coordenar merge).

---

## Implementation Strategy

**MVP first (US1)**: Phases 1–3 entregam o pedido central (pré-registro + auto-join). Parar no checkpoint da US1, validar com o quickstart e, se desejado, abrir PR só com isso.

**Incremental**: US2 em seguida (vínculo + unificação), que é onde mora a complexidade de RLS e migração de dados — beneficia-se de revisão dedicada. Polish fecha com regressão e lint.

**Pontos de risco a tratar com calma** (do plan.md): T015 (policies own-rows — testar vazamento/bloqueio com 3 contas: membro, vinculada, alheia) e T016 (colisões de UNIQUE e `is_latest` — testar unificação com dados sintéticos antes de rodar em projeto real).
