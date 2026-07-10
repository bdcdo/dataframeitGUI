# Implementation Plan: Documentos com exportação completa

**Branch**: `004-export-original-metadata` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-export-original-metadata/spec.md`

## Summary

Preservar a linha original inteira do CSV importado junto a cada documento (reusando a coluna `documents.metadata JSONB`, que existe desde a migration inicial e nunca foi populada) e mover a exportação para um card no topo de Configurações > Documentos, exportando sempre o conjunto completo (documentos + respostas individuais + gabarito) com escolha apenas de formato (CSV unificado ou XLSX com abas). A sub-aba "Exportar" de Revisões e sua rota são removidas. Tudo permanece coordinator-only — decisão de clarificação de 2026-07-10 removeu a antiga US3 (leitura para membros), aceitando explicitamente a regressão de acesso dos pesquisadores ao export. Sem migration, sem dependência nova, sem mudança de RLS.

## Technical Context

**Language/Version**: TypeScript 5.7 (frontend Next.js 16 App Router, React 19)

**Primary Dependencies**: papaparse (parse do CSV no import — já em uso), exceljs (geração de XLSX — já em uso, import dinâmico), shadcn/ui, Supabase JS (client autenticado `lib/supabase/server.ts`)

**Storage**: Supabase Postgres — coluna existente `documents.metadata JSONB` (`001_initial_schema.sql:83`); **sem migration nova**. RLS existente já cobre (leitura de membros via `Members view documents`; escrita coordinator-only via `Coordinators manage documents`) — nenhuma policy muda.

**Testing**: Vitest (unit para `lib/` e `actions/`, padrão `makeSupabaseMock` de `src/actions/__tests__/supabase-mock.ts`)

**Target Platform**: Web desktop (constituição: desktop-first)

**Project Type**: Web application (frontend Next.js; backend FastAPI não é tocado nesta feature)

**Performance Goals**: SC-007 — export de projeto com ≤50 docs e respostas em ≤10s; página Documentos continua carregando sem buscar `metadata`/`text` na listagem (fetch pesado só na ação de export)

**Constraints**: payload de Server Action ≤ ~4,5MB (limites vigentes `MAX_CHUNK_BYTES = 3_500_000` e `MAX_DOCS_PER_CHUNK = 500` em `frontend/src/lib/upload-chunking.ts`) — a medição de bytes passa a incluir o metadata; geração de arquivo client-side (sem ZIP, sem job assíncrono — FR-017)

**Scale/Scope**: projetos típicos com dezenas a poucas centenas de documentos; CSVs com até ~30 colunas originais observados nos projetos reais (Zolgensma)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Princípio | Avaliação | Status |
|---|---|---|
| I. Usabilidade | Card de export no topo de Documentos com escolha única (formato); remove o seletor de dataset e a área escondida em Revisões — menos decisões, mais descoberta. | PASS |
| II. Velocidade | Colunas explícitas em toda query; `metadata` **não** entra na query de listagem da página (fetch só na server action de export, sob demanda); exceljs segue lazy via `import()` dinâmico; queries do export paralelizadas com `Promise.all` (padrão atual mantido). | PASS |
| III. Segurança | Nenhuma superfície nova: server action gated por `requireCoordinator`, client autenticado via RLS; nenhum uso de service key. | PASS |
| IV. RLS-por-padrão | Nenhuma tabela nova; policies existentes de `documents` já cobrem leitura/escrita. | PASS |
| V. Robustez via testes | Código novo em `lib/` (montagem de export, chunking) e `actions/` (export, upload alargado) nasce com Vitest; a montagem de datasets é extraída para funções puras justamente para ser testável. | PASS |
| VI. A11y WCAG AA | Card usa componentes shadcn/ui existentes (Card, Select/Tabs, Button) que já carregam a base de a11y; preview é tabela HTML com cabeçalhos. | PASS |
| VII. Fonte única do schema | Não toca `PydanticField` nem schema de codificação. | N/A |
| VIII. Simplicidade de stack | Zero dependência nova; zero camada nova; FastAPI não é tocado; mutations/reads seguem Server Actions/RSC. | PASS |

**Re-check pós-design (Phase 1)**: PASS — o design final não introduziu violações; Complexity Tracking vazio.

## Project Structure

### Documentation (this feature)

```text
specs/004-export-original-metadata/
├── plan.md              # Este arquivo
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1
│   └── export-and-upload.md
└── tasks.md             # Phase 2 (/speckit-tasks — não criado por /speckit-plan)
```

### Source Code (repository root)

```text
frontend/src/
├── lib/
│   ├── upload-chunking.ts            # MODIFICA: buildDocs captura linha original; utf8Bytes conta metadata
│   └── export/                       # NOVO: montagem pura e testável dos datasets de export
│       ├── assemble.ts               # documentos/respostas/gabarito → headers+rows; colisão; ordenação
│       └── format.ts                 # formatExportValue, formatação de veredicto (extraídos da page atual)
├── actions/
│   ├── documents.ts                  # MODIFICA: UploadDoc ganha metadata (flui até o INSERT/RPC existentes)
│   └── export.ts                     # NOVO: getExportDataset(projectId) gated por requireCoordinator
├── components/
│   ├── documents/
│   │   └── ExportCard.tsx            # NOVO: card client no topo de Documentos (formato + preview + download)
│   ├── stats/ExportPanel.tsx         # REMOVE (superseded)
│   └── reviews/ReviewsNav.tsx        # MODIFICA: remove a aba "Exportar"
├── hooks/
│   └── useDocumentUpload.ts          # MODIFICA: propaga linha original do papaparse ao buildDocs
└── app/(app)/projects/[id]/
    ├── config/documents/page.tsx     # MODIFICA: renderiza ExportCard antes da lista
    └── reviews/export/               # REMOVE (rota inteira)

frontend/src/lib/__tests__/           # upload-chunking.test.ts (amplia) + export/*.test.ts (novo)
frontend/src/actions/__tests__/       # documents.test.ts (amplia) + export.test.ts (novo)
```

**Structure Decision**: web application existente; a feature é 100% frontend (Next.js). A montagem dos datasets sai do RSC `reviews/export/page.tsx` para `lib/export/` como funções puras (testáveis, sem I/O), consumidas por uma server action nova; a geração de arquivo permanece client-side no `ExportCard` (padrão atual do `ExportPanel`, que é removido).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

Sem violações — tabela vazia.
