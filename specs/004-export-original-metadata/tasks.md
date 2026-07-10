# Tasks: Documentos com exportação completa

**Input**: Design documents from `/specs/004-export-original-metadata/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/export-and-upload.md, quickstart.md

**Tests**: INCLUÍDOS — a constituição (Princípio V) exige que código novo em `frontend/src/lib` e `frontend/src/actions` nasça com Vitest; os testes de cada story precedem a implementação correspondente.

**Organization**: tarefas agrupadas por user story, cada story é um incremento independentemente testável. Feature 100% frontend (Next.js); backend FastAPI não é tocado.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: paralelizável (arquivos distintos, sem dependência de tarefa incompleta)
- **[Story]**: US1 (preservar base original), US2 (export no topo de Documentos), US3 (documentos antigos)

## Path Conventions

Web app — todos os paths sob `frontend/` (raiz do repo: `frontend/src/...`).

---

## Phase 1: Setup

**Purpose**: preparar a worktree para desenvolvimento e validar o baseline.

- [ ] T001 Instalar dependências na worktree (`cd frontend && npm ci`) e validar baseline com `npm run typecheck && npx vitest run` — worktrees não herdam `node_modules` e symlink com lockfile em drift gera falso-verde/falso-vermelho

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: tipo compartilhado entre import (US1, escrita) e export (US2/US3, leitura).

- [ ] T002 Definir o tipo `DocumentMetadata` (`{ original_row: Record<string, string>; original_columns: string[] }`) em `frontend/src/lib/types.ts` e tipar `DocumentRow.metadata` em `frontend/src/actions/documents.ts` como `DocumentMetadata | null` (hoje `Record<string, unknown>`; a coluna nunca foi populada, tightening é seguro)

**Checkpoint**: tipo disponível — US1 e US2 podem seguir em paralelo.

---

## Phase 3: User Story 1 - Preservar a base original importada (Priority: P1) 🎯 MVP

**Goal**: cada documento importado por CSV guarda a linha original completa em `documents.metadata` (shape do data-model.md §1), incluindo colunas mapeadas e não mapeadas, com célula vazia preservada como `""`.

**Independent Test**: importar CSV com colunas extras além das mapeadas; conferir no banco (ou via export futuro) que `metadata.original_row` tem todas as colunas e `metadata.original_columns` preserva a ordem do CSV (quickstart.md §1).

### Tests for User Story 1 (escrever primeiro, ver falhar)

- [ ] T003 [P] [US1] Ampliar `frontend/src/lib/__tests__/upload-chunking.test.ts`: `buildDocs` popula `metadata.original_row` (linha inteira, inclusive colunas mapeadas; células ausentes → `""`) e `metadata.original_columns` (= `csv.columns`, na ordem); linhas sem texto continuam descartadas. Incluir teste de regressão da garantia de cabeçalhos únicos: CSV com colunas homônimas parseado via papaparse (`header: true`) chega com duplicatas renomeadas (`nome`, `nome_1`) e todos os valores preservados — comportamento verificado no papaparse 5.5.4, do qual `buildDocs` depende sem normalizar de novo (achado C2 do /speckit-analyze)
- [ ] T004 [P] [US1] Ampliar `frontend/src/lib/__tests__/upload-chunking.test.ts`: a medição de bytes de `chunkByBytes` passa a contar o documento serializado completo (metadata incluído) — chunk que caberia só pelo `text` estoura com metadata; fail-early de doc único acima de `MAX_CHUNK_BYTES` considera o tamanho real
- [ ] T005 [P] [US1] Ampliar `frontend/src/actions/__tests__/documents.test.ts` (padrão `makeSupabaseMock`): `uploadDocuments` persiste `metadata` nos rows do INSERT (`add_all`/`add_new_only`) e no payload da RPC `replace_and_add_documents`; `metadata` ausente → `null` (compatibilidade)

### Implementation for User Story 1

- [ ] T006 [US1] Implementar em `frontend/src/lib/upload-chunking.ts`: `buildDocs` captura a linha completa (`original_row` normalizando ausentes para `""`, `original_columns` de `csv.columns`); medição `utf8Bytes`/`chunkByBytes` sobre o doc serializado completo; alargar `UploadDoc` para incluir `metadata` (contrato em contracts/export-and-upload.md §2-3)
- [ ] T007 [US1] Verificar `frontend/src/actions/documents.ts`: `metadata` do `UploadDoc` flui inalterado até o INSERT dos 3 modos e a RPC (o transporte já existe — `metadata: doc.metadata || null`); ajustar apenas tipagem se T002/T006 exigirem
- [ ] T008 [US1] Verificar `frontend/src/hooks/useDocumentUpload.ts` e `frontend/src/components/documents/MappingStep.tsx`: `buildDocs` já recebe o `csv` completo (rows+columns) — confirmar que nada trunca a linha antes do `buildDocs` e atualizar `frontend/src/hooks/__tests__/useDocumentUpload.test.ts` se o shape mockado mudar

**Checkpoint**: `npx vitest run` verde; importar um CSV real em dev e conferir `metadata` populado (quickstart.md §1). US1 entregável sozinha (dado preservado, ainda sem export novo).

---

## Phase 4: User Story 2 - Encontrar exportação no topo de Documentos (Priority: P2)

**Goal**: card de exportação no topo de Configurações > Documentos (formato CSV/XLSX apenas, preview de 10 linhas), exportando o conjunto completo (documentos + respostas + gabarito, com linha `source=documento` para docs órfãos e colunas originais); aba "Exportar" de Revisões e rota antiga removidas.

**Independent Test**: quickstart.md §2 e §4 — card antes da lista, CSV unificado com `source` ∈ {llm, codificacao, comparacao, documento} e colunas originais, XLSX com abas Documentos/Respostas/Gabarito, colisão renomeada `original_*`, aba antiga inexistente.

### Tests for User Story 2 (escrever primeiro, ver falhar)

- [ ] T009 [P] [US2] Criar `frontend/src/lib/__tests__/export-format.test.ts`: `formatExportValue` (null/string/array/objeto) e formatação de veredicto (`ambiguo`→`[AMBIGUO]`, `pular`→`[PULAR]`, multi JSON → join `; `) — comportamento idêntico ao atual de `reviews/export/page.tsx`
- [ ] T010 [P] [US2] Criar `frontend/src/lib/__tests__/export-assemble.test.ts` com fixtures cobrindo: união ordenada de `original_columns` (docs por `created_at` asc, primeira aparição vence); colisão → `original_<nome>` (e `_2` em colisão persistente), idêntica no CSV e na aba Documentos; auto-fill de concordância respeitando `min_responses_for_comparison` (multi via conjuntos, demais via `normalizeForComparison`); prioridade veredicto > concordância > vazio; linha `source=documento` só para doc sem resposta E sem gabarito; colunas originais repetidas nas linhas do mesmo doc no CSV unificado; projeto sem respostas → só linhas `documento`, sem erro; documento excluído fica fora da visão Documentos e suas respostas/gabarito são descartados (nenhuma linha referencia documento ausente da base — achado C1); documento com exclusão apenas pendente permanece na base
- [ ] T011 [P] [US2] Criar `frontend/src/actions/__tests__/export.test.ts` (padrão `makeSupabaseMock` + mock de `requireCoordinator`): `getExportDataset` retorna `{error}` fail-closed para não-coordenador; queries com colunas explícitas em paralelo; monta o shape do contrato (contracts/export-and-upload.md §1)

### Implementation for User Story 2

- [ ] T012 [P] [US2] Criar `frontend/src/lib/export/format.ts`: extrair `formatExportValue` e a formatação de veredicto de `frontend/src/app/(app)/projects/[id]/reviews/export/page.tsx` como funções puras exportadas
- [ ] T013 [US2] Criar `frontend/src/lib/export/assemble.ts`: funções puras que montam as visões Documentos/Respostas/Gabarito e o CSV unificado (data-model.md §3), portando de `reviews/export/page.tsx` a lógica de datasets e o auto-fill de concordância; a montagem descarta respostas/gabarito de documentos fora da base exportada (achado C1); depende de T012
- [ ] T014 [US2] Criar `frontend/src/actions/export.ts`: server action `getExportDataset(projectId)` — `"use server"` só com exports async (lição PR #412), gate `requireCoordinator`, 4 queries paralelas (`projects` name/pydantic_fields/min_responses_for_comparison; `documents` id/external_id/title/created_at/metadata com `excluded_at IS NULL` — exclusão pendente permanece; `responses` is_latest; `reviews`), delega a montagem a `lib/export/assemble.ts`; depende de T013
- [ ] T015 [US2] Criar `frontend/src/components/documents/ExportCard.tsx` (client): busca `getExportDataset` apenas em interação explícita do usuário (primeiro clique no card / botão "Gerar prévia" — nunca no mount, para a página Documentos não pagar o custo em toda visita; achado A1), escolha só de formato (CSV/XLSX), preview de até 10 linhas da visão unificada (padrão herdado do ExportPanel), download CSV com BOM + escaping manual e XLSX via `import("exceljs")` dinâmico (3 abas: Documentos sempre; Respostas/Gabarito quando houver linhas), estados loading/erro/vazio em pt-BR; depende de T014
- [ ] T016 [US2] Integrar o card em `frontend/src/app/(app)/projects/[id]/config/documents/page.tsx`, renderizado antes da lista (a página segue sem buscar `metadata`/`text` na listagem); depende de T015
- [ ] T017 [P] [US2] Remover a entrada `{ label: "Exportar", href: "export" }` de `frontend/src/components/reviews/ReviewsNav.tsx`
- [ ] T018 [US2] Remover o diretório `frontend/src/app/(app)/projects/[id]/reviews/export/` e o componente `frontend/src/components/stats/ExportPanel.tsx` (nenhum outro consumidor — verificado no plan); depende de T012-T013 (a lógica precisa já ter sido portada)

**Checkpoint**: `npm run typecheck && npx vitest run` verdes; quickstart.md §2 e §4.1 validados em dev. US1+US2 juntas entregam o fluxo completo de ponta a ponta.

---

## Phase 5: User Story 3 - Exportar documentos antigos sem quebrar o fluxo (Priority: P3)

**Goal**: documentos com `metadata IS NULL` (importados antes da feature) continuam exportáveis — colunas originais vazias, sem erro, misturados a documentos novos.

**Independent Test**: quickstart.md §3 — projeto com docs antigos gera CSV e XLSX sem erro; colunas originais vazias para os antigos, preenchidas para os novos.

### Tests for User Story 3 (escrever primeiro, ver falhar)

- [ ] T019 [US3] Ampliar `frontend/src/lib/__tests__/export-assemble.test.ts` com fixtures de `metadata: null`: base 100% antiga (zero colunas originais no header — só controle+schema), base mista (header = união dos docs novos; antigos com células vazias), doc antigo sem resposta ainda gera linha `source=documento`

### Implementation for User Story 3

- [ ] T020 [US3] Garantir em `frontend/src/lib/export/assemble.ts` o tratamento de `metadata IS NULL` que os testes de T019 exigem (por design deve já estar coberto pela união de colunas — corrigir se algum teste falhar); depende de T013

**Checkpoint**: suíte verde; quickstart.md §3 validado num projeto real antigo (ex.: Zolgensma, docs pré-feature).

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: gates de qualidade, validação runtime e preparação do PR.

- [ ] T021 [P] Rodar gates locais completos em `frontend/`: `npm run typecheck`, `npm run lint:types`, `npm run react-doctor`, `npx vitest run` — corrigir o que a feature introduziu (débito legado permanece grandfathered)
- [ ] T022 [P] Validação runtime via subagente Playwright (regra do usuário: delegar checks E2E a subagente) seguindo quickstart.md §1-§4: import com colunas extras, download CSV/XLSX, colisão, aba Exportar removida, redirect de não-coordenador; cronometrar o download completo num projeto de ~50 documentos e registrar o tempo contra o alvo de ≤10s (SC-007; achado G1)
- [ ] T023 Revisão adversarial do diff por subagente somente-leitura antes do commit final/PR (regra default do usuário); incorporar achados e repetir gates afetados
- [ ] T024 Commit final, push e abertura de PR contra `main` via `gh pr create` com `Closes` das issues aplicáveis (linha de keyword em inglês) e corpo em pt-BR resumindo a regressão de acesso aceita (US3 antiga removida)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: sem dependências
- **Phase 2 (Foundational)**: depende de Phase 1 — bloqueia todas as stories
- **Phase 3 (US1)**: depende de Phase 2. Independente de US2/US3
- **Phase 4 (US2)**: depende de Phase 2. Consome `metadata` gravado pela US1 para valor pleno, mas é implementável e testável sem ela (fixtures); a remoção da rota antiga (T017-T018) só depende do port da lógica (T012-T013)
- **Phase 5 (US3)**: depende de T013 (assemble existir). Independente de US1
- **Phase 6 (Polish)**: depende de todas as stories desejadas no PR

### User Story Dependencies

- US1 (P1): nenhuma — MVP
- US2 (P2): nenhuma dura; sinergia com US1 (export mostra colunas originais quando US1 já gravou)
- US3 (P3): tecnicamente contida no design da US2; fase própria garante teste explícito do legado

### Within Each User Story

Testes primeiro (ver falhar) → implementação → checkpoint com suíte verde.

### Parallel Opportunities

```text
# Dentro da US1 (após T002): T003, T004, T005 em paralelo (arquivos de teste distintos)
# Dentro da US2 (após T002): T009, T010, T011 em paralelo; depois T012 ∥ T017
# Entre stories (após Phase 2): US1 (T003-T008) ∥ US2 (T009-T016) — arquivos disjuntos
# Polish: T021 ∥ T022
```

---

## Implementation Strategy

### MVP First (User Story 1 apenas)

1. Phase 1 + Phase 2 (T001-T002)
2. Phase 3 completa (T003-T008): dado preservado desde já — cada import novo passa a guardar a linha original, mesmo antes do export novo existir. **Valor imediato: nenhuma importação futura perde dados.**
3. Validar via quickstart.md §1; parar aqui já é entregável (commit/PR parcial possível)

### Incremental Delivery

1. US1 → preservação ativa (MVP)
2. US2 → export completo no topo de Documentos + remoção da rota antiga (fluxo de ponta a ponta)
3. US3 → cobertura explícita do legado
4. Polish → gates, validação runtime delegada, revisão adversarial, PR

Um único PR ao final é o esperado (feature coesa), mas os checkpoints permitem cortar em US1 se necessário.
