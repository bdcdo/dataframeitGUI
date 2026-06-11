# Tasks: Pré-registro de membros sem conta e vínculo de múltiplos e-mails

**Input**: Design documents from `/specs/002-preregister-members/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D6), data-model.md, contracts/server-actions.md, quickstart.md

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

- [X] T002 Migration `frontend/supabase/migrations/20260611120000_profiles_activated_at.sql`: `ALTER TABLE profiles ADD COLUMN activated_at TIMESTAMPTZ` + backfill `UPDATE profiles SET activated_at = created_at` (data-model.md §profiles); aplicar com `npx supabase db push` e confirmar no banco
- [X] T003 [P] Adicionar `activated_at: string | null` ao tipo `Profile` em `frontend/src/lib/types.ts`

**Checkpoint**: coluna existe no banco remoto; tipos compilam

---

## Phase 3: User Story 1 - Pré-registrar pessoa sem conta no projeto (Priority: P1) 🎯 MVP

**Goal**: coordenador adiciona e-mail sem conta → membro "pendente" elegível para atribuições; auto-join no primeiro acesso; correção/remoção de pendentes.

**Independent Test**: quickstart.md §US1 — pré-registrar e-mail virgem, atribuir documentos, criar conta com o e-mail e verificar projeto + atribuições no primeiro acesso (badge some).

### Implementation for User Story 1

- [X] T004 [US1] Criar helper `preregisterSupabaseUser(email): Promise<string>` em `frontend/src/lib/clerk-sync.ts`: cria `auth.users` (admin, email_confirm) + `profiles` com `activated_at = NULL`, idempotente para e-mail já existente (research D1)
- [X] T005 [US1] Refatorar `addMember` em `frontend/src/actions/members.ts`: validar formato do e-mail + normalizar lowercase (FR-006); trocar criação de usuário Clerk (linhas 51-80, incl. workaround Turnstile) por `preregisterSupabaseUser`; retornar `{ pending: true }` no lugar de `invited` (contracts §addMember)
- [X] T006 [P] [US1] Webhook `frontend/src/app/api/webhooks/clerk/route.ts`: após `syncClerkUserToSupabase`, setar `profiles.activated_at = now()` se `NULL` (transição pendente→ativo, FR-004/SC-005)
- [X] T007 [P] [US1] Fallback em `getAuthUser()` em `frontend/src/lib/auth.ts`: se profile da sessão tem `activated_at IS NULL`, setar `now()` (cobre webhook perdido e contas antigas, research D2)
- [X] T008 [US1] Nova action `updatePendingMemberEmail(projectId, memberUserId, newEmail)` em `frontend/src/actions/members.ts`: só para `activated_at IS NULL`; atualiza `auth.users` (admin API) + `profiles.email`; efeito é global (FR-005) — retornar `otherProjectsCount` para a UI avisar quando o pendente pertence a outros projetos; erros do contrato (contracts §updatePendingMemberEmail)
- [X] T009 [US1] `removeMember` em `frontend/src/actions/members.ts`: deletar também `assignments` com `status = 'pendente'` do usuário no projeto (FR-005, research D6)
- [X] T010 [US1] Query da página `frontend/src/app/(app)/projects/[id]/config/members/page.tsx`: incluir `activated_at` no select do join `profiles` (colunas explícitas)
- [X] T011 [US1] `frontend/src/components/members/MemberList.tsx`: badge "Pendente" (shadcn Badge) para `activated_at === null` + ação "Corrigir e-mail" (visível só em pendentes) chamando `updatePendingMemberEmail` com aviso quando `otherProjectsCount > 0`; aplicar o mesmo badge na seleção de pesquisadores do sorteio em `frontend/src/components/assignments/LotteryDialog.tsx` (research D5)
- [X] T012 [P] [US1] `frontend/src/components/members/AddMemberDialog.tsx`: toast para `pending: true` — "Membro pré-registrado. Ele entrará no projeto ao criar conta com este e-mail." (sem promessa de envio de e-mail)
- [X] T013 [US1] Testes Vitest em `frontend/src/actions/__tests__/members.test.ts` (arquivo existente): validação/normalização de e-mail do `addMember` e idempotência do `preregisterSupabaseUser` (mock do admin client)
- [ ] T014 [US1] Validar quickstart.md §US1 (passos 1–5) no ambiente real

**Checkpoint**: US1 completa e testável de ponta a ponta — MVP entregável

---

## Phase 4: User Story 2 - Vincular mais de um e-mail ao mesmo pesquisador (Priority: P2)

**Goal**: coordenador vincula e-mails adicionais; qualquer e-mail vinculado acessa o projeto como o mesmo membro (atribuições unificadas); unificação confirmada quando o e-mail já é outro membro; desvínculo.

**Independent Test**: quickstart.md §US2 — vincular e-mail sem conta a um membro, criar conta com ele e verificar acesso como o mesmo membro; unificar dois membros e conferir soma de atribuições sem perda de respostas.

### Implementation for User Story 2

- [ ] T015 [US2] Migration `frontend/supabase/migrations/20260611130000_member_email_links.sql`: tabela `member_email_links` + 3 indexes + policies (SELECT membros, mutação coordenadores) + estender `auth_user_accessible_project_ids()` + criar `auth_user_member_identity_ids(p_project_id)` + atualizar policies own-rows de `responses` (respondent_id), `reviews` (reviewer_id) e `field_reviews` (self_reviewer_id/arbitrator_id) conforme data-model.md §RLS; aplicar com `npx supabase db push`
- [ ] T016 [US2] Migration `frontend/supabase/migrations/20260611140000_unify_project_members.sql`: função `unify_project_members(p_project_id, p_source_user_id, p_target_user_id)` SECURITY DEFINER com a tabela de migração de colunas e tratamento de colisões do data-model.md (UNIQUE de assignments → target prevalece; recálculo de `is_latest` em responses); aplicar com `npx supabase db push`
- [ ] T017 [P] [US2] Tipo `MemberEmailLink` em `frontend/src/lib/types.ts` (campos da tabela)
- [ ] T018 [US2] `getEffectiveMemberId(projectId: string)` em `frontend/src/lib/auth.ts`: resolve `member_user_id` se houver alias para `user.id` no projeto, senão `user.id` (contracts §Resolução de identidade efetiva)
- [ ] T019 [US2] Actions `linkMemberEmail` (4 casos do contrato, incluindo retorno `requiresUnification` com preview: atribuições a migrar, docs com resposta de ambos, papel resultante) e `unlinkMemberEmail` em `frontend/src/actions/members.ts`
- [ ] T020 [US2] Action `unifyMembers(projectId, sourceUserId, targetUserId)` em `frontend/src/actions/members.ts`: checagem de coordenador + RPC `unify_project_members` via admin + revalidação de members/assignments/compare
- [ ] T021 [US2] Webhook `frontend/src/app/api/webhooks/clerk/route.ts`: resolver vínculos pendentes — `UPDATE member_email_links SET linked_user_id = <profile> WHERE email = <email> AND linked_user_id IS NULL` — e ativar os membros canônicos desses vínculos (`profiles.activated_at = now()` dos `member_user_id` resolvidos, se NULL; SC-005 caminho via alias, contracts §Webhook passo 3)
- [ ] T022 [US2] Adotar effective member id nos pontos de trabalho: `frontend/src/app/(app)/projects/[id]/analyze/code/page.tsx`, `frontend/src/app/(app)/projects/[id]/my-progress/page.tsx`, `frontend/src/actions/responses.ts` (respondent_id), `frontend/src/actions/field-reviews.ts` (self/arbitrator), compondo com o padrão `viewAsUser` existente
- [ ] T023 [P] [US2] Novo `frontend/src/components/members/LinkEmailDialog.tsx`: input de e-mail + estados dos 4 casos do contrato (sucesso, requer unificação, e-mail já vinculado, erro)
- [ ] T024 [P] [US2] Novo `frontend/src/components/members/UnifyMembersDialog.tsx`: confirmação explícita com o preview retornado por `linkMemberEmail` (FR-009) e aviso de permanência (clarificação Q1)
- [ ] T025 [US2] `frontend/src/components/members/MemberList.tsx`: exibir e-mails vinculados por membro (FR-015) + ações vincular (abre LinkEmailDialog) e desvincular; nesta fase, ajustar `removeMember` em `frontend/src/actions/members.ts` para deletar também os `member_email_links` do membro removido no projeto (contracts §removeMember — T009 na US1 cobre só assignments)
- [ ] T026 [US2] Query da página `frontend/src/app/(app)/projects/[id]/config/members/page.tsx`: buscar `member_email_links` do projeto (colunas explícitas, `Promise.all` com a query de membros)
- [ ] T027 [US2] Testes Vitest em `frontend/src/actions/__tests__/members.test.ts`: matriz de casos do `linkMemberEmail`, resolução de `getEffectiveMemberId`, montagem do preview de unificação (mocks de client)
- [ ] T028 [US2] Validar quickstart.md §US2 (passos 1–5) no ambiente real, incluindo verificação RLS: conta vinculada acessa o projeto mas **não** os demais projetos do membro, e conta alheia não lê os links

**Checkpoint**: US1 e US2 funcionais e independentes

---

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T029 [P] Rodar react-doctor/lint no frontend e resolver diagnósticos introduzidos pela feature
- [ ] T030 Revisão de performance das queries novas: colunas explícitas, sem N+1 na lista de membros, `getEffectiveMemberId` sem chamada duplicada por request (memoizar via cache() se necessário)
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
