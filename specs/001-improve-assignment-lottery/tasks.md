# Tasks: Melhorar o sorteio de atribuições

**Input**: Design documents from `/specs/001-improve-assignment-lottery/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/server-actions.md, quickstart.md

**Tests**: Testes unitários incluídos apenas para a função pura `filterEligibleDocs` (decisão research D10); demais validações são manuais via quickstart.md.

**Organization**: Tarefas agrupadas por user story (US1–US6 da spec), com fases Setup e Foundational bloqueantes antes delas.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: paralelizável (arquivos diferentes, sem dependência de tarefa incompleta)
- **[Story]**: user story a que a tarefa pertence (US1–US6)

## Path Conventions

Web app — tudo em `frontend/` (Next.js App Router); migrations em `frontend/supabase/migrations/`. Backend FastAPI não participa.

---

## Phase 1: Setup

**Purpose**: workspace e schema prontos para a implementação

- [ ] T001 Confirmar workspace: implementação neste checkout primário, branch `001-improve-assignment-lottery` ativa (decisão registrada no plano — exceção pontual à regra de worktree; sem worktree nesta feature)
- [ ] T002 Criar migration `frontend/supabase/migrations/<timestamp>_lottery_mode_filters.sql` adicionando a `assignment_batches`: `mode TEXT NOT NULL DEFAULT 'replace' CHECK (mode IN ('append','replace'))` e `filters JSONB` (shape em data-model.md)
- [ ] T003 Aplicar a migration no projeto remoto via fluxo manual do CLAUDE.md (`cd frontend && export SUPABASE_ACCESS_TOKEN=... && npx supabase link --project-ref nryebmwlmxuwvynfuzsv && npx supabase db push`) — aditiva com default, segura de aplicar antes do código

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: primitiva pura de elegibilidade + Server Actions v2 + base do dialog — bloqueia todas as user stories

**⚠️ CRITICAL**: nenhuma story começa antes desta fase terminar

- [ ] T004 [P] Criar `frontend/src/lib/lottery-utils.ts` com os tipos `LotteryMode`, `AssignmentFilter`, `LotteryFilters`, `LotteryDocStats` e a função pura `filterEligibleDocs(docs, type, filters)` aplicando interseção na ordem fixa do data-model.md (manual → codificações → status de atribuição → lote)
- [ ] T005 [P] Criar testes Vitest em `frontend/src/lib/__tests__/lottery-utils.test.ts`: cada filtro isolado; composição por interseção; `maxHumanCodings` 0 e N; `noActiveOfType` vs `neverAssigned`; lote `only` e `exclude`; manual ∩ filtros; resultado vazio
- [ ] T006 Implementar `getLotteryDocStats(projectId)` em `frontend/src/actions/assignments.ts`: queries paralelas com colunas explícitas (documents ativos `id, external_id, title`; responses `document_id, respondent_id` com `is_latest=true` e `respondent_type='humano'`; assignments `document_id, user_id, status, type, batch_id`; assignment_batches `id, label, created_at`; projects `min_responses_for_comparison`), agregando para `{ docs: LotteryDocStats[], batches, minResponsesForComparison }` (contrato em contracts/server-actions.md)
- [ ] T007 Reescrever `LotteryParams` (v2: `mode`, `filters`, `participantIds`; sem campos de deadline e sem `includedCoordinatorIds`) e `computeLottery` em `frontend/src/actions/assignments.ts`: validar `participantIds` contra `project_members` (qualquer role); aplicar `filterEligibleDocs`; conjunto preservado por modo (`append` = todas as atribuições do tipo inclusive pendentes, `replace` = só `em_andamento`/`concluido`); manter exigência mínima de comparação compondo com os filtros; remover o cálculo de deadlines (passo 11) e o wrapper legado `randomizeAssignments`
- [ ] T008 Atualizar `smartRandomize` e `previewLottery` em `frontend/src/actions/assignments.ts`: DELETE de pendentes só quando `mode === 'replace'`; batch grava `mode`, `filters` (JSONB com participantIds e docSubsetSize) e `deadline_mode: 'none'`; inserts sem `deadline`; preview retorna `participants` (sem deadline) + `totalNew` + `totalPreserved` + `eligibleDocs`; erros pt-BR do contrato (participante inválido, zero elegíveis, filtros de lote mutuamente exclusivos)
- [ ] T009 Refatorar base do `frontend/src/components/assignments/LotteryDialog.tsx`: carregar stats via `getLotteryDocStats` na abertura do dialog; estados de filtros/modo/participantes; contagem de elegíveis e estimativa por participante recalculadas client-side via `filterEligibleDocs`; "Visualizar prévia" e "Sortear" desabilitados com 0 elegíveis ou 0 participantes, com mensagem contextual no lugar da estimativa (research D9)
- [ ] T010 Atualizar `frontend/src/app/(app)/projects/[id]/analyze/assignments/page.tsx`: passar `members: { userId, name, role }[]` (pesquisadores + coordenadores, nomes já carregados) ao `LotteryDialog`; remover props antigas `totalDocs`, `totalResearchers`, `coordinators`

**Checkpoint**: dialog abre, carrega stats, sorteia com params v2 (UI das seções novas ainda ausente)

---

## Phase 3: User Story 1 - Filtrar documentos elegíveis por codificações e atribuições (Priority: P1) 🎯 MVP

**Goal**: coordenador restringe o sorteio a docs sem codificação / com no máximo N / por status de atribuição, com contagem ao vivo

**Independent Test**: em projeto com docs parcialmente codificados, filtrar "sem nenhuma codificação" e sortear; só docs sem codificação recebem atribuições

- [ ] T011 [US1] Adicionar seção "Documentos elegíveis" no `frontend/src/components/assignments/LotteryDialog.tsx`: RadioGroup de codificações (todos / sem nenhuma / no máximo N com Input numérico) + Select de status de atribuição (qualquer / sem atribuição ativa do tipo / nunca atribuído), ligados a `filters.maxHumanCodings` e `filters.assignmentFilter`
- [ ] T012 [US1] Validar acceptance scenarios da US1 (quickstart passo 2): contagem de elegíveis reage aos filtros; sorteio respeita os filtros; combinação de filtros opera por interseção

**Checkpoint**: US1 funcional e testável de ponta a ponta

---

## Phase 4: User Story 2 - Sortear lote novo sem destruir atribuições pendentes (Priority: P1) 🎯 MVP

**Goal**: escolha explícita entre acrescentar (default) e substituir pendentes do tipo

**Independent Test**: sortear Lote 1; sortear Lote 2 em modo acrescentar; pendentes do Lote 1 intactas e zero duplicidades

- [ ] T013 [US2] Adicionar RadioGroup "Atribuições pendentes" no `frontend/src/components/assignments/LotteryDialog.tsx` (acrescentar ao existente = default / substituir pendentes), ligado a `params.mode`, com texto curto explicando o efeito de cada modo
- [ ] T014 [US2] Validar acceptance scenarios da US2 (quickstart passos 3–4): append preserva todas as pendentes preexistentes; replace descarta e redistribui só as pendentes do tipo; em ambos os modos nada toca em_andamento/concluído e não há duplicidade doc+pessoa+tipo

**Checkpoint**: US1 + US2 entregam o fluxo de lotes incrementais (MVP)

---

## Phase 5: User Story 3 - Controlar quem participa do sorteio (Priority: P2)

**Goal**: lista única de membros com toggle individual (pesquisadores ON, coordenadores OFF)

**Independent Test**: desligar um pesquisador e sortear; ele não recebe atribuições novas

- [ ] T015 [US3] Substituir a seção "Coordenadores" por seção "Participantes" no `frontend/src/components/assignments/LotteryDialog.tsx`: Switch por membro de `members` (pesquisadores ligados por default, coordenadores desligados), alimentando `participantIds`; estimativa recalcula a cada toggle
- [ ] T016 [US3] Exibir nomes dos participantes na tabela de prévia do `LotteryDialog.tsx` (lookup em `members`) em vez de `userId.slice(0, 8)`
- [ ] T017 [US3] Validar acceptance scenarios da US3 (quickstart passo 5): pesquisador desligado não recebe; coordenador ligado recebe; todos desligados bloqueia o sorteio com mensagem

**Checkpoint**: pool de participantes totalmente controlável

---

## Phase 6: User Story 4 - Filtrar documentos por lote anterior (Priority: P2)

**Goal**: excluir docs de lotes selecionados ou restringir a um lote específico

**Independent Test**: sortear lote rotulado; segundo sorteio excluindo esse lote não redistribui nenhum doc dele

- [ ] T018 [US4] Adicionar UI do filtro por lote no `frontend/src/components/assignments/LotteryDialog.tsx`: lista de lotes (label + data, vinda de `batches` das stats) com seleção múltipla para `filters.batchFilter.exclude` e seleção única para `filters.batchFilter.only`, mutuamente exclusivos na UI
- [ ] T019 [US4] Validar acceptance scenarios da US4 (quickstart passo 6): exclusão de lote remove seus docs da elegibilidade; "somente do lote" restringe a ele

**Checkpoint**: filtros automáticos completos

---

## Phase 7: User Story 5 - Selecionar manualmente os documentos do sorteio (Priority: P3)

**Goal**: marcar documentos específicos numa lista pesquisável; compõe por interseção com os demais filtros

**Independent Test**: marcar 5 docs e sortear; só esses 5 distribuem

- [ ] T020 [P] [US5] Criar `frontend/src/components/assignments/DocumentPickerList.tsx`: Input de busca client-side por título/`external_id`, checkbox por documento, contador "N selecionados", lista com `max-h` + scroll (sem virtualização — research D6)
- [ ] T021 [US5] Integrar o `DocumentPickerList` no `LotteryDialog.tsx` atrás de Switch "Selecionar documentos manualmente", alimentando `filters.manualDocIds`
- [ ] T022 [US5] Validar acceptance scenarios da US5 (quickstart passo 7): só os marcados distribuem; manual ∩ filtro de codificações vale a interseção; subset aleatório amostra dentro da seleção

**Checkpoint**: todos os controles de elegibilidade entregues

---

## Phase 8: User Story 6 - Sortear sem configurar prazo (Priority: P3)

**Goal**: dialog sem nenhuma configuração de prazo; sorteios novos sem deadline

**Independent Test**: percorrer o dialog (sem seção de prazo) e sortear (atribuições com deadline NULL)

- [ ] T023 [US6] Remover do `frontend/src/components/assignments/LotteryDialog.tsx` a seção Prazo inteira (Collapsible, Calendar, Popover, estados `deadlineOpen`/`deadlineMode`/`deadlineDate`/`recurringCount`/`recurringStart`, `todayMidnight`, imports órfãos de date-fns/lucide) e a coluna "Prazo" da tabela de prévia
- [ ] T024 [US6] Validar acceptance scenarios da US6 (quickstart passo 8): nenhuma opção de prazo no dialog; atribuições novas com `deadline` NULL; prazos antigos seguem visíveis no resto da plataforma (fora do escopo — issue #176)

**Checkpoint**: todas as user stories entregues

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T025 Rodar `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run` limpos; gate react-doctor roda no pre-commit (usar `--diff`)
- [ ] T026 Validação manual completa do quickstart.md, incluindo bordas (0 elegíveis, 0 participantes, manual + subset) e SC-005 (prévia ≡ resultado do sorteio para a mesma configuração)
- [ ] T027 Abrir PR contra `main` via `gh pr create` (título `feat(sorteio): ...`, corpo em pt-BR referenciando `specs/001-improve-assignment-lottery/`; sem keyword de auto-close — a issue #176 é escopo separado); se `api.github.com` seguir inacessível, usar o workaround REST com `curl --resolve` registrado na memória da sessão

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências; T003 depende de T002
- **Foundational (Phase 2)**: depende do Setup (T003 aplicada antes de exercitar `smartRandomize` v2) — BLOQUEIA todas as stories. Ordem interna: T004 → (T005 ∥ T006) → T007 → T008 → T009 → T010 (T005 só depende de T004)
- **User Stories (Phases 3–8)**: todas dependem só do Foundational; logicamente independentes entre si
- **Polish (Phase 9)**: depende das stories desejadas

### User Story Dependencies

Nenhuma story depende de outra. Atenção prática: T011, T013, T015, T016, T018, T021 e T023 editam o mesmo arquivo (`LotteryDialog.tsx`) — executá-las sequencialmente para evitar conflitos; a independência é de teste/entrega, não de arquivo.

### Parallel Opportunities

- T004 ∥ T002 (arquivos distintos); T005 ∥ T006 após T004
- T020 (`DocumentPickerList.tsx`, arquivo novo) pode ser desenvolvido em paralelo a qualquer fase pós-Foundational
- Tarefas de validação (T012, T014, T017, T019, T022, T024) podem ser agrupadas numa única sessão de teste manual se as stories forem implementadas em sequência

## Parallel Example: Foundational

```bash
# Após T004 concluída:
Task: "Testes Vitest em frontend/src/lib/__tests__/lottery-utils.test.ts"   # T005
Task: "getLotteryDocStats em frontend/src/actions/assignments.ts"           # T006
```

## Implementation Strategy

### MVP First (US1 + US2)

1. Phases 1–2 (Setup + Foundational)
2. Phase 3 (US1: filtros por codificações/status) → validar
3. Phase 4 (US2: modo acrescentar/substituir) → validar
4. **PARAR e VALIDAR**: o fluxo de lotes incrementais — o motivo da feature — já funciona; dá para abrir PR parcial aqui se desejado

### Incremental Delivery

Cada story seguinte (US3 participantes → US4 lote → US5 manual → US6 prazo) é um incremento testável que não quebra os anteriores. US6 é quase só remoção de código e pode ser antecipada sem custo se conveniente (reduz o diff do dialog antes das seções novas).

## Notes

- Commitar após cada tarefa ou grupo lógico (mensagens pt-BR, 72 chars na primeira linha)
- O invariante `UNIQUE(document_id, user_id, type)` do banco é a rede de segurança final contra duplicidade — o código deve evitá-la antes (preservedSet)
- Não tocar em `AssignmentTable.tsx`, `progress.ts` ou my-progress (remoção total de prazo = issue #176)
