---
description: "Task list for feature: Caminho de autenticação rápido e recuperável"
---

# Tasks: Caminho de autenticação rápido e recuperável

**Input**: Design documents from `/specs/003-auth-render-path/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED. The feature explicitly requires regression evidence (FR-014, FR-015, SC-006) and the four contracts plus quickstart enumerate mandatory Vitest regressions. Test tasks are therefore first-class here, not optional.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Web app — frontend at `frontend/src/`. Server helpers in `frontend/src/lib/`, App Router/webhook routes in `frontend/src/app/`, Server Actions in `frontend/src/actions/` and components in `frontend/src/components/`. Os testes atuais vivem em `lib/__tests__/`, `actions/__tests__/`, `app/**/__tests__/`, ao lado da rota Clerk (`route.test.ts`) e em `frontend/supabase/tests/` para o contrato SQL.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare test surface. Project, stack and dependencies already exist — no scaffolding or new libraries.

- [X] T001 Inventory existing auth/authorization test coverage and confirm Vitest picks up new specs, listing current tests that touch `frontend/src/lib/auth.ts` and `frontend/src/lib/clerk-sync.ts` in `frontend/src/lib/__tests__/`
- [X] T002 [P] Add a shared test helper for building a fake Clerk session + Supabase link state (prepared / pending / divergent / no-email) in `frontend/src/lib/__tests__/auth-test-helpers.ts`, reused across US1–US3 regressions

**Checkpoint**: Test harness ready — foundational refactor can begin.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Reshape identity resolution so link completion/repair is no longer done inside the protected render path. Every user story depends on this.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 Define the internal auth-resolution union — `signed-out` | `authenticated` | `access-completion-required` | `technical-sync-failure` — in `frontend/src/lib/auth.ts`; export `resolveAuth()` and keep `getAuthUser()` as the thin authenticated/null projection for callers that already fail closed
- [X] T004 Split read and repair: `resolveAuth()`/`getAuthUser()` stay read-only and `cache()`d; they never call `reconcileClerkUserAccess()` from the protected render path
- [X] T005 Preserve first-login and recovery with `reconcileClerkUserAccess(clerkUserId)` in `frontend/src/lib/clerk-sync.ts`, invoked explicitly by Clerk webhooks and `frontend/src/actions/complete-access.ts`; keep `preregisterSupabaseUser()` idempotent
- [X] T006 Classify mapping/metadata absent or marker `0` as `access-completion-required`; classify ausência de primário verificado e falhas técnicas as `technical-sync-failure`, all fail-closed in `frontend/src/lib/auth.ts`

**Checkpoint**: Identity resolution is render-safe and repair is out of the critical path. User stories can now proceed.

---

## Phase 3: User Story 1 - Acessar projeto sem espera perceptível de autenticação (Priority: P1) 🎯 MVP

**Goal**: An authenticated user with a prepared account link opens the dashboard or a project page without repeating remote identity work per consumer; identity is resolved once per request.

**Independent Test**: With an authenticated account whose link is already prepared, open a project page with no browser cache and confirm the page is usable within the budget with a single identity resolution per request (no per-read re-resolution).

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL before implementation)

- [X] T007 [P] [US1] Regression RC-001 in `frontend/src/lib/__tests__/auth-request-dedup.test.ts`: uma resolução preparada faz exatamente `currentUser` + mapping + `master_users` uma vez cada; deduplicação entre consumidores RSC é garantia de runtime do `cache()` e recebe instrumentação estrutural separada
- [X] T008 [P] [US1] Regression RC-002 in `frontend/src/lib/__tests__/auth-no-remote-lookup.test.ts`: caminho preparado tem teto fixo de 3 lookups (`currentUser`, mapping, master), enquanto pendente termina após 2 e não consulta master; o custo não cresce por leitura protegida

### Implementation for User Story 1

- [X] T009 [US1] Confirm `cache()` de-duplication between `frontend/src/app/(app)/layout.tsx` and `frontend/src/app/(app)/projects/[id]/layout.tsx`: ambos chamam somente `resolveAuth()`, sem `currentUser()`/`auth()` direto. NOTE (I1): executar antes de T018 porque os arquivos são compartilhados
- [X] T010 [US1] Add observability/counter evidence for SC-002 (number of identity resolutions per representative request) via a request-scoped debug counter or test instrumentation in `frontend/src/lib/auth.ts`, without leaking to the client
- [X] T011 [US1] Sweep protected pages/actions: layouts/pages usam `resolveAuth`/`getProjectAccessContext`; mutations pessoais usam exclusivamente `resolveProjectMemberActor`; mutations de coordenação usam `requireCoordinator`

**Checkpoint**: US1 fully functional and independently testable — MVP candidate.

---

## Phase 4: User Story 2 - Concluir acesso quando o vínculo de conta ainda não está pronto (Priority: P2)

**Goal**: A signed-in user whose internal link is not yet ready reaches a clear, non-technical access-completion state in pt-BR with a safe retry, instead of a silent block, a loop, or a raw error.

**Independent Test**: With an authenticated session lacking a confirmed internal link, hit a protected page and confirm redirect to access completion with a comprehensible message and a retry that, on success, lands on the dashboard/intended URL — and repeating retry never duplicates records.

### Tests for User Story 2 ⚠️ (write first, ensure they FAIL before implementation)

- [X] T012 [P] [US2] Regression RC-005 (fail-closed on missing/divergent link): assert a valid Clerk session with absent/divergent link redirects protected renders to access completion and shows no project data, in `frontend/src/lib/__tests__/auth-fail-closed.test.ts`
- [X] T013 [P] [US2] Test the four rendered reasons (`link-pending`, `link-divergent`, `sync-temporary-failure`, `unknown-recoverable`) in `frontend/src/app/auth/__tests__/access-completion-reason.test.tsx`; cover active account without projects separately in `frontend/src/app/(app)/dashboard/__tests__/page.test.tsx`
- [X] T014 [P] [US2] Test the action result/delegation in `frontend/src/actions/__tests__/complete-access.test.ts` and retry idempotence without duplicate mapping/profile/aliases in `frontend/src/lib/__tests__/clerk-sync.test.ts`
- [X] T015 [P] [US2] Accessibility test (C3, Constitution §VI / FR-009 / contracts/access-completion.md): assert the access-completion screen is keyboard-navigable, sets initial focus, exposes associated labels and an accessible retry button, and renders no token/claims/debug text, in `frontend/src/app/auth/__tests__/access-completion-a11y.test.tsx`

### Implementation for User Story 2

- [X] T016 [US2] Add `frontend/src/app/auth/post-login/page.tsx` + `frontend/src/components/auth/AccessCompletionCard.tsx`, rendering the four reason states with pt-BR, shadcn/ui, foco inicial, região viva e nenhum token/claim/debug/table name
- [X] T017 [US2] Implement `completeAccess()` in `frontend/src/actions/complete-access.ts`: reler a conta por `clerkUserId` via `reconcileClerkUserAccess`, retornar `sync-temporary-failure | unknown-recoverable` sem propagar detalhe e permitir retry idempotente
- [X] T018 [US2] Wire fail-closed redirects in `frontend/src/app/(app)/layout.tsx` and `frontend/src/app/(app)/projects/[id]/layout.tsx`: `access-completion-required`/`technical-sync-failure` → access-completion route; do NOT convert an identity-sync failure into project `notFound()` and do NOT send a link-pending user back to login as if signed out. (I1: depends on T009 — same files)
- [X] T019 [US2] Distinguish active account without projects from `technical-sync-failure` in `frontend/src/app/(app)/dashboard/page.tsx`, covered by `frontend/src/app/(app)/dashboard/__tests__/page.test.tsx`; `no-project-access` is not an access-completion reason
- [X] T020 [US2] Success transitions: on confirmed active link, redirect to safe `nextUrl` or dashboard; on persistent failure, show a short non-technical support hint, in `frontend/src/app/auth/post-login/page.tsx` + `frontend/src/actions/complete-access.ts`

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 - Preservar permissões, aliases e impersonação (Priority: P3)

**Goal**: Coordinators, direct researchers, linked-email researchers and master users in `viewAs` continue to see and change only what they already could; the auth change never widens permissions and never confuses the real actor with the effective/visualized identity.

**Independent Test**: Run representative accounts per role against the same projects/actions before and after the change and confirm each sees/edits only what was already allowed — and `viewAs` grants no write as the visualized identity.

### Tests for User Story 3 ⚠️ (write first, ensure they FAIL before implementation)

- [X] T021 [P] [US3] Test: coordinator (creator / `coordenador` role / master) retains coordination via `getProjectAccessContext(projectId, user)`, in `frontend/src/lib/__tests__/auth-effective-member.test.ts`
- [X] T022 [P] [US3] Test: direct researcher resolves `accountUserId` and `memberUserId` to the same identity, in `frontend/src/lib/__tests__/auth-effective-member.test.ts`
- [X] T023 [P] [US3] Test: linked-email researcher resolves `memberUserId` to the canonical member while preserving `accountUserId`, in `frontend/src/lib/__tests__/auth-effective-member.test.ts`
- [X] T024 [P] [US3] Test: master with `viewAs` resolves a visualized queue without substituir o ator autenticado que assina writes (FR-006), in `frontend/src/lib/__tests__/viewas-no-write.test.ts`; controles somente leitura de Comparação seguem no PR #445
- [X] T025 [P] [US3] Test: `unavailable` interrupts project access instead of becoming a partial authorization context, in `frontend/src/lib/__tests__/project-access.test.ts`

### Implementation for User Story 3

- [X] T026 [US3] Keep three explicit doors in `frontend/src/lib/auth.ts`: `getProjectAccessContext(projectId, user)` for page/layout access, `resolveProjectMemberActor(projectId)` for personal mutations, and `resolveProjectQueueIdentity(access, viewAsUser)` for viewed queues
- [X] T027 [US3] Ensure `viewAs` never reaches `resolveProjectMemberActor` or changes the authenticated actor in `frontend/src/actions/**`; UI somente leitura para Comparação é rastreada separadamente pelo PR #445

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Regression guards and measured evidence spanning all stories.

- [X] T028 [P] Regression RC-003/RC-004: a check that fails if the legacy custom-token path or a general service-key data-access path is reintroduced into ordinary protected rendering (e.g. lint/grep gate or Vitest), documented in `specs/003-auth-render-path/contracts/regression-checks.md` evidence, added under `frontend/src/lib/__tests__/no-legacy-token-path.test.ts`
- [ ] T029 RC-006 / SC-001 performance evidence (M2 — define the metric): measure **first-usable latency of a representative protected page under no-browser-cache** with an explicit metric (TTFB→first-contentful/interactive of the protected content, chosen and stated in the PR), target 150–250 ms, ceiling 300 ms p95; note that this measures the auth contribution isolated from the Constitution §II page budgets (LCP < 2.5s), not a replacement for them. Record command/scenario/metric per `quickstart.md`
  - **Status (pendente de deploy):** métrica definida (`regression-checks.md`), instrumentação `AUTH_RESOLVE_DEBUG` pronta e `next build` de produção validado. O número p95 **representativo** exige medição num deploy sem cache de navegador (hardware/região de produção) — não reproduzível localmente de forma fiel. Fica para colher após o deploy.
- [X] T030 [P] Map each regression check (RC-001…RC-007) to current tests/instrumentation in `contracts/regression-checks.md`
- [X] T031 Run `quickstart.md` validation end-to-end (`cd frontend && npm run typecheck && npm run test -- --run`), plus the manual role/completion/no-project passes; **include a sign-out assertion (C2 / FR-016)** confirming existing login and sign-out behavior stays recognizable, changed only by the clearer completion/error states
- [X] T032 Document the FR-013 measured-contingency gate (C1): record in `specs/003-auth-render-path/contracts/regression-checks.md` (and the PR) that any non-default local token path is out of scope by default and may only be considered after the official Clerk/Supabase path is measured to fail the SC-001 target AND passes an explicit security review; T028 (RC-004) enforces the inverse guard against silent reintroduction
- [X] T033 RC-007 / FR-017–FR-018: persistir o protocolo em `frontend/supabase/migrations/20260715173000_canonical_project_identity_rls.sql`, validá-lo localmente e cobrir seleção do primário em `clerk-primary-email.test.ts`, geração/retry/revogação em `clerk-sync.test.ts`, roteamento do webhook em `app/api/webhooks/clerk/route.test.ts`, leitura fail-closed em `auth-fail-closed.test.ts` e contrato SQL em `supabase/tests/clerk_mapping_completion.test.sql`; aplicação remota permanece operação manual separada

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (T003 → T004 → T005/T006).
- **User Stories (Phase 3–5)**: All depend on Phase 2. US1 is the MVP; US2 depends on the relocated idempotent routine (T005) and the outcome type (T003); US3 depends on the refactor not having changed the access/alias/viewAs contracts.
- **Polish (Phase 6)**: Depends on all targeted stories being complete.

### User Story Dependencies

- **US1 (P1)**: After Foundational. No dependency on US2/US3.
- **US2 (P2)**: After Foundational. Consumes T003 (outcome type) and T005 (idempotent routine); independently testable.
- **US3 (P3)**: After Foundational. Mostly preservation + regression; independently testable.

### Cross-story file coupling (I1)

- T009 [US1] and T018 [US2] both edit `frontend/src/app/(app)/layout.tsx` and `frontend/src/app/(app)/projects/[id]/layout.tsx`. They are **not** parallelizable with each other: complete T009 (dedup verification) before T018 (fail-closed wiring) to avoid a same-file conflict. All other cross-story tasks touch distinct files.

### Within Each User Story

- Tests written first and made to FAIL before implementation.
- Types/outcomes before consumers; the access-completion action before wiring layouts.
- Story complete before moving to next priority.

### Parallel Opportunities

- T002 (helper) parallel with T001 review.
- Within US1: T007, T008 in parallel. Within US2: T012, T013, T014, T015 in parallel (four distinct test files). Within US3: T021–T025 all parallel.
- Across stories: once Phase 2 lands, US1/US2/US3 can be staffed in parallel — except the T009→T018 layout ordering above.
- In Polish: T028 and T030 parallel; T029/T031/T032 run after implementation.

---

## Parallel Example: User Story 3

```bash
# Canonical access scenarios share one fixture; viewAs and the pure fail-closed gate remain isolated:
Task: "account/member identity and coordinator roles in auth-effective-member.test.ts"
Task: "viewAs no-write in viewas-no-write.test.ts"
Task: "unavailable access closed denial in project-access.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup.
2. Phase 2: Foundational (CRITICAL — render-safe identity resolution).
3. Phase 3: US1 — request-scoped dedup + teto fixo de lookups no caminho preparado.
4. **STOP and VALIDATE**: measure a representative protected page and confirm single resolution per request.

### Incremental Delivery

1. Setup + Foundational → identity resolution is render-safe.
2. US1 → measure/regress the perf win (MVP, addresses issue #187 directly).
3. US2 → recoverable access-completion state (no silent block).
4. US3 → preserved roles/aliases/viewAs guarded by regression.
5. Polish → RC-003/RC-004 guards + p95 evidence + quickstart validation + FR-013 gate doc.

---

## Notes

- [P] = different files, no dependency on incomplete tasks.
- [Story] label maps each task to a spec.md user story for traceability.
- The heavy code change is T004/T005 (removing silent repair from the render path); everything in US1/US3 leans on existing `cache()`d helpers.
- Verify each test fails before implementing it.
- Commit after each task or logical group; per user's explicit choice, implementation happens on this same `003-auth-render-path` branch (no separate implementation worktree) — still never on `main`.
- Do not replace ordinary protected reads with `createSupabaseAdmin()`/service key; keep Clerk + JWT Supabase + RLS as the boundary.
