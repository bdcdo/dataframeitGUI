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

Web app — frontend at `frontend/src/`. Server helpers in `frontend/src/lib/`, App Router routes in `frontend/src/app/`, Server Actions in `frontend/src/actions/`, components in `frontend/src/components/`, tests co-located under `frontend/src/lib/__tests__/` and `frontend/src/app/**/__tests__/` per existing Vitest convention.

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

- [X] T003 Define the auth-resolution outcome type — `signed-out` | `authenticated` | `access-completion-required` | `technical-sync-failure` — per `specs/003-auth-render-path/contracts/auth-resolution.md`, exported from `frontend/src/lib/auth.ts` (or a new `frontend/src/lib/auth-resolution.ts` re-exported by `auth.ts`)
- [X] T004 Split "resolve session / prepared link" from "complete / repair link": remove the `syncClerkUserToSupabase(...)` call from the `getAuthUser` render path (`frontend/src/lib/auth.ts:36`) so a protected render never silently repairs the link (decision D3), while keeping `getAuthUser` wrapped in `cache()`
- [X] T005 Preserve first-login behavior by relocating the link preparation/repair logic (formerly inline in `getAuthUser`) into an idempotent, explicitly-invoked routine reused by the access-completion action, keeping the idempotence guarantees of `frontend/src/lib/clerk-sync.ts` (`syncClerkUserToSupabase`, `preregisterSupabaseUser`)
- [X] T006 Make `getAuthUser` return/signal `access-completion-required` (vs `technical-sync-failure` when no usable email) instead of attempting repair, so protected pages can fail closed, in `frontend/src/lib/auth.ts`

**Checkpoint**: Identity resolution is render-safe and repair is out of the critical path. User stories can now proceed.

---

## Phase 3: User Story 1 - Acessar projeto sem espera perceptível de autenticação (Priority: P1) 🎯 MVP

**Goal**: An authenticated user with a prepared account link opens the dashboard or a project page and starts working without a remote identity-provider lookup on the critical render path, and identity is resolved once per request.

**Independent Test**: With an authenticated account whose link is already prepared, open a project page with no browser cache and confirm the page is usable within the budget with a single identity resolution per request (no per-read re-resolution).

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL before implementation)

- [X] T007 [P] [US1] Regression RC-001 (identity resolved once per request): assert `getAuthUser` de-duplicates across a parent layout + project layout + multiple reads in the same request, in `frontend/src/lib/__tests__/auth-request-dedup.test.ts`
- [X] T008 [P] [US1] Regression RC-002 (no full remote lookup on prepared path): **first fix M1 — define the measured target explicitly**: "full remote identity-provider lookup" = the count of Clerk `currentUser()`/`auth()` remote round-trips plus any Supabase `profiles`/`clerk_user_mapping` lookups per protected request. The test asserts that, for a prepared-link user, this count is exactly one per request (from the single cached `getAuthUser`), not once per protected read, in `frontend/src/lib/__tests__/auth-no-remote-lookup.test.ts`

### Implementation for User Story 1

- [X] T009 [US1] Confirm/ensure `cache()` de-duplication is honored end-to-end between `frontend/src/app/(app)/layout.tsx` and `frontend/src/app/(app)/projects/[id]/layout.tsx` (no direct `currentUser()`/`auth()` calls bypassing `getAuthUser`). NOTE (I1): these two layout files are also edited by T018 [US2] — do T009 before T018 to avoid a same-file conflict; they are not parallel
- [X] T010 [US1] Add observability/counter evidence for SC-002 (number of identity resolutions per representative request) via a request-scoped debug counter or test instrumentation in `frontend/src/lib/auth.ts`, without leaking to the client
- [X] T011 [US1] Sweep protected pages/actions that read project data for repeated identity resolution and route them through `getAuthUser`/`getProjectAccessContext` (`frontend/src/app/(app)/**`, `frontend/src/actions/**`)

**Checkpoint**: US1 fully functional and independently testable — MVP candidate.

---

## Phase 4: User Story 2 - Concluir acesso quando o vínculo de conta ainda não está pronto (Priority: P2)

**Goal**: A signed-in user whose internal link is not yet ready reaches a clear, non-technical access-completion state in pt-BR with a safe retry, instead of a silent block, a loop, or a raw error.

**Independent Test**: With an authenticated session lacking a confirmed internal link, hit a protected page and confirm redirect to access completion with a comprehensible message and a retry that, on success, lands on the dashboard/intended URL — and repeating retry never duplicates records.

### Tests for User Story 2 ⚠️ (write first, ensure they FAIL before implementation)

- [X] T012 [P] [US2] Regression RC-005 (fail-closed on missing/divergent link): assert a valid Clerk session with absent/divergent link redirects protected renders to access completion and shows no project data, in `frontend/src/lib/__tests__/auth-fail-closed.test.ts`
- [X] T013 [P] [US2] Reason-classification tests covering `link-pending`, `link-divergent`, `sync-temporary-failure`, `no-project-access`, `unknown-recoverable` per `contracts/access-completion.md` and `data-model.md`, in `frontend/src/app/auth/__tests__/access-completion-reason.test.ts`
- [X] T014 [P] [US2] Idempotent-retry test (SC-007): repeating access completion for the same account produces at most one profile link and no duplicate `profiles` / `clerk_user_mapping` / memberships, in `frontend/src/actions/__tests__/complete-access.test.ts`
- [X] T015 [P] [US2] Accessibility test (C3, Constitution §VI / FR-009 / contracts/access-completion.md): assert the access-completion screen is keyboard-navigable, sets initial focus, exposes associated labels and an accessible retry button, and renders no token/claims/debug text, in `frontend/src/app/auth/__tests__/access-completion-a11y.test.ts`

### Implementation for User Story 2

- [X] T016 [US2] Add the access-completion route/page under `frontend/src/app/auth/access-completion/page.tsx` (pt-BR, shadcn/ui, keyboard-navigable, visible focus, WCAG 2.1 AA, no token/claims/debug/table-name exposure), rendering the five `reason` states from `contracts/access-completion.md`
- [X] T017 [US2] Implement the idempotent access-completion Server Action (retry of link preparation/repair) in `frontend/src/actions/complete-access.ts`, reusing the relocated idempotent routine (T005) and `frontend/src/lib/clerk-sync.ts`
- [X] T018 [US2] Wire fail-closed redirects in `frontend/src/app/(app)/layout.tsx` and `frontend/src/app/(app)/projects/[id]/layout.tsx`: `access-completion-required`/`technical-sync-failure` → access-completion route; do NOT convert an identity-sync failure into project `notFound()` and do NOT send a link-pending user back to login as if signed out. (I1: depends on T009 — same files)
- [X] T019 [US2] Distinguish `no-project-access` (active account, no memberships) from `technical-sync-failure` on the dashboard, per `data-model.md` Project Access Context rules, in `frontend/src/app/(app)/**` dashboard entry
- [X] T020 [US2] Success transitions: on confirmed active link, redirect to safe `nextUrl` or dashboard; on persistent failure, show a short non-technical support hint, in `frontend/src/app/auth/access-completion/page.tsx` + `frontend/src/actions/complete-access.ts`

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 - Preservar permissões, aliases e impersonação (Priority: P3)

**Goal**: Coordinators, direct researchers, linked-email researchers and master users in `viewAs` continue to see and change only what they already could; the auth change never widens permissions and never confuses the real actor with the effective/visualized identity.

**Independent Test**: Run representative accounts per role against the same projects/actions before and after the change and confirm each sees/edits only what was already allowed — and `viewAs` grants no write as the visualized identity.

### Tests for User Story 3 ⚠️ (write first, ensure they FAIL before implementation)

- [X] T021 [P] [US3] Test: coordinator (creator / `coordenador` role / master) retains coordination tabs and actions via `getProjectAccessContext`, in `frontend/src/lib/__tests__/project-access-coordinator.test.ts`
- [X] T022 [P] [US3] Test: direct researcher sees only own-member documents/queues, in `frontend/src/lib/__tests__/project-access-researcher.test.ts`
- [X] T023 [P] [US3] Test: linked-email researcher resolves to the canonical member via `getEffectiveMemberId`/`resolveEffectiveUserId`, in `frontend/src/lib/__tests__/effective-member-alias.test.ts`
- [X] T024 [P] [US3] Test: master with `viewAs` reads/navigates as the visualized identity but writes are NOT granted as the visualized user (FR-006), in `frontend/src/lib/__tests__/viewas-no-write.test.ts`
- [X] T025 [P] [US3] Test: authenticated user without access gets a closed denial with no project data leaked, in `frontend/src/lib/__tests__/project-access-denied.test.ts`

### Implementation for User Story 3

- [X] T026 [US3] Verify `getProjectAccessContext` and `resolveEffectiveUserId` remain the single sources of project+role and master-impersonation/alias precedence after the Phase 2 refactor, adjusting only if the refactor changed their inputs, in `frontend/src/lib/auth.ts`
- [X] T027 [US3] Ensure `viewAs`/impersonation scope is read/navigation/visual-only across protected write surfaces (write remains as the real actor when already permitted, otherwise forbidden), auditing `frontend/src/actions/**` and personal-queue call sites

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Regression guards and measured evidence spanning all stories.

- [X] T028 [P] Regression RC-003/RC-004: a check that fails if the legacy custom-token path or a general service-key data-access path is reintroduced into ordinary protected rendering (e.g. lint/grep gate or Vitest), documented in `specs/003-auth-render-path/contracts/regression-checks.md` evidence, added under `frontend/src/lib/__tests__/no-legacy-token-path.test.ts`
- [ ] T029 RC-006 / SC-001 performance evidence (M2 — define the metric): measure **first-usable latency of a representative protected page under no-browser-cache** with an explicit metric (TTFB→first-contentful/interactive of the protected content, chosen and stated in the PR), target 150–250 ms, ceiling 300 ms p95; note that this measures the auth contribution isolated from the Constitution §II page budgets (LCP < 2.5s), not a replacement for them. Record command/scenario/metric per `quickstart.md`
  - **Status (pendente de deploy):** métrica definida (`regression-checks.md`), instrumentação `AUTH_RESOLVE_DEBUG` pronta e `next build` de produção validado. O número p95 **representativo** exige medição num deploy sem cache de navegador (hardware/região de produção) — não reproduzível localmente de forma fiel. Fica para colher após o deploy.
- [X] T030 [P] Map each regression check (RC-001…RC-006) to its covering test/instrumentation and record the evidence table in the PR description
- [X] T031 Run `quickstart.md` validation end-to-end (`cd frontend && npm run typecheck && npm run test -- --run`), plus the manual role/completion/no-project passes; **include a sign-out assertion (C2 / FR-016)** confirming existing login and sign-out behavior stays recognizable, changed only by the clearer completion/error states
- [X] T032 Document the FR-013 measured-contingency gate (C1): record in `specs/003-auth-render-path/contracts/regression-checks.md` (and the PR) that any non-default local token path is out of scope by default and may only be considered after the official Clerk/Supabase path is measured to fail the SC-001 target AND passes an explicit security review; T028 (RC-004) enforces the inverse guard against silent reintroduction

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
# All US3 regression tests can be written in parallel (different files):
Task: "coordinator retains coordination in project-access-coordinator.test.ts"
Task: "direct researcher scope in project-access-researcher.test.ts"
Task: "linked-email alias resolution in effective-member-alias.test.ts"
Task: "viewAs no-write in viewas-no-write.test.ts"
Task: "no-access closed denial in project-access-denied.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup.
2. Phase 2: Foundational (CRITICAL — render-safe identity resolution).
3. Phase 3: US1 — request-scoped dedup + no remote lookup on prepared path.
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
