# Implementation Plan: Melhorar o sorteio de atribuições

**Branch**: `001-improve-assignment-lottery` | **Date**: 2026-06-10 | **Updated**: 2026-06-11 (US7 — equilíbrio configurável) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-improve-assignment-lottery/spec.md`

## Summary

Dar ao coordenador controle sobre o sorteio de atribuições em quatro eixos: elegibilidade de documentos (filtros por nº de codificações humanas, status de atribuição, lote anterior e seleção manual), interação com atribuições pendentes (modo acrescentar — novo default — vs substituir), pool de participantes (toggle individual por membro) e equilíbrio da distribuição (só a rodada atual — novo default — vs considerando rodadas anteriores). Remover a configuração de prazo do dialog e corrigir os defeitos do algoritmo atual que concentram documentos num único participante.

Abordagem técnica: a elegibilidade é calculada por uma função pura compartilhada (`filterEligibleDocs` em `frontend/src/lib/lottery-utils.ts`) aplicada sobre estatísticas leves por documento carregadas uma vez na abertura do dialog — o client usa a função para contagem ao vivo e para a lista de seleção manual; o server (`computeLottery`) reaplica a mesma função como fonte de verdade no preview e na execução. O modo acrescentar muda o conjunto "preservado" de `computeLottery` de "não-pendentes" para "todas as atribuições do tipo" e suprime o DELETE de pendentes em `smartRandomize`. O núcleo de distribuição sai de `computeLottery` para uma segunda função pura (`distributeDocs`), com critério primário de carga conforme o modo de equilíbrio, variação de duplas como critério secundário e desempate aleatório (research.md D12). Toda a aleatoriedade deriva de um PRNG seedado: a prévia retorna a semente e o sorteio a reaproveita, garantindo prévia ≡ execução com dados inalterados (research.md D13). A configuração usada (modos + filtros + participantes + semente) é registrada em `assignment_batches` via migration aditiva.

## Technical Context

**Language/Version**: TypeScript 5.7 (frontend Next.js 16 App Router, React 19)

**Primary Dependencies**: shadcn/ui (new-york), Supabase JS (Postgres + RLS via Clerk JWT), sonner, lucide-react

**Storage**: Supabase Postgres — tabelas existentes `documents`, `assignments`, `responses`, `assignment_batches`, `project_members`; uma migration aditiva em `assignment_batches`

**Testing**: Vitest (frontend) — unit tests das funções puras de elegibilidade (`filterEligibleDocs`) e distribuição (`distributeDocs`, com RNG injetável); backend FastAPI não é tocado

**Target Platform**: Web desktop (alvo é desktop/mouse; densidade > alvos de toque, conforme CLAUDE.md)

**Project Type**: Web application (frontend Next.js; mutations via Server Actions, reads via RSC)

**Performance Goals**: contagem de elegíveis atualiza instantaneamente a cada mudança de filtro (filtragem client-side de stats pré-carregadas, sem round-trip); abertura do dialog com 1 fetch agregado de stats; sorteio insere em chunks de 100 (padrão atual)

**Constraints**: queries com colunas explícitas, sem `select("*")`, sem N+1, paralelizar com `Promise.all` (regras de performance do CLAUDE.md); RLS existente cobre todas as tabelas envolvidas; nenhuma dependência nova

**Scale/Scope**: projetos com ~100–5.000 documentos e ~5–30 membros; stats por documento (id, título, contagens) cabem confortavelmente num payload único

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` ainda é o template não ratificado (adoção pendente na issue #175). Na ausência de constituição, os gates aplicados são as regras duras do `CLAUDE.md` do projeto:

| Gate | Avaliação |
|------|-----------|
| Server Actions para mutations, RSC para reads | PASS — sorteio continua em Server Actions (`assignments.ts`); stats de elegibilidade via nova Server Action de leitura chamada pelo client do dialog |
| shadcn/ui para todos os componentes | PASS — filtros usam RadioGroup/Switch/Input/Popover/Command já presentes no projeto |
| Queries: colunas explícitas, sem N+1, `Promise.all`, count/agregação | PASS — desenho do fetch de stats em research.md cumpre as regras; nenhum UPDATE/INSERT em loop novo |
| Português na UI, inglês no código | PASS |
| Sem dependência pesada nova / lazy-load | PASS — nenhuma dependência nova |
| RLS: índices nas colunas de policies para tabelas novas | PASS — nenhuma tabela nova; migration só adiciona colunas a `assignment_batches` (RLS já existente) |
| Worktree + branch + PR, nunca push na main | PASS — implementação ocorrerá em worktree própria na branch `001-improve-assignment-lottery` |

Re-check pós-Phase 1: PASS (nenhuma violação introduzida pelo desenho; sem entradas em Complexity Tracking).

Re-check pós-US7 (2026-06-11): PASS — o redesenho da distribuição adiciona apenas uma função pura em `lib/` (sem dependência nova, sem tabela nova), a migration continua aditiva sobre `assignment_batches`, e as Server Actions permanecem o único canal de mutation.

## Project Structure

### Documentation (this feature)

```text
specs/001-improve-assignment-lottery/
├── plan.md              # Este arquivo
├── research.md          # Phase 0 — decisões de desenho
├── data-model.md        # Phase 1 — entidades e migration
├── quickstart.md        # Phase 1 — como rodar e validar
├── contracts/
│   └── server-actions.md  # Phase 1 — contratos das Server Actions
└── tasks.md             # Phase 2 (/speckit-tasks — não criado aqui)
```

### Source Code (repository root)

```text
frontend/
├── src/
│   ├── lib/
│   │   └── lottery-utils.ts                 # NOVO — tipos de filtro + filterEligibleDocs e
│   │                                        #   distributeDocs (puras, RNG injetável)
│   ├── lib/__tests__/
│   │   └── lottery-utils.test.ts            # NOVO — unit tests Vitest (filtros + distribuição)
│   ├── actions/
│   │   └── assignments.ts                   # ALTERADO — LotteryParams v2, getLotteryDocStats,
│   │                                        #   computeLottery com filtros/modos delegando a
│   │                                        #   distributeDocs, remoção de deadline
│   ├── components/assignments/
│   │   ├── LotteryDialog.tsx                # ALTERADO — seções de filtros, modos (atribuição e
│   │   │                                    #   equilíbrio), participantes; remoção da seção Prazo
│   │   └── DocumentPickerList.tsx           # NOVO — lista pesquisável p/ seleção manual
│   └── app/(app)/projects/[id]/analyze/assignments/
│       └── page.tsx                         # ALTERADO — passa members (nome+role) ao dialog
└── supabase/migrations/
    └── 20260611XXXXXX_lottery_mode_filters.sql  # NOVA — mode + balancing + filters em assignment_batches
```

**Structure Decision**: feature inteiramente no frontend (Next.js) + uma migration SQL. O backend FastAPI não participa (sorteio é CRUD/distribuição, não LLM/Pydantic). As lógicas de elegibilidade e de distribuição vivem em primitivas puras compartilhadas em `lib/`, seguindo o padrão já adotado pelo projeto para `schema-utils.ts` (primitivas puras reutilizadas por actions e scripts, evitando drift — cf. #63).

## Complexity Tracking

Sem violações — tabela não aplicável.
