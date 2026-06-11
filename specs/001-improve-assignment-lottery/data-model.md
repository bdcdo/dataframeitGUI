# Data Model: Melhorar o sorteio de atribuições

**Feature**: 001-improve-assignment-lottery | **Date**: 2026-06-10 | **Updated**: 2026-06-11 (US7 — coluna `balancing`, distribuição redesenhada)

Nenhuma tabela nova. Uma migration aditiva em `assignment_batches`; as demais entidades são lidas como estão.

## Alteração de schema

### `assignment_batches` (migration `20260611XXXXXX_lottery_mode_filters.sql`)

| Coluna nova | Tipo | Regra | Descrição |
|-------------|------|-------|-----------|
| `mode` | TEXT NOT NULL DEFAULT `'replace'` | CHECK (`mode IN ('append','replace')`) | Interação do sorteio com pendentes; default descreve lotes históricos (todos substitutivos) |
| `balancing` | TEXT NOT NULL DEFAULT `'history'` | CHECK (`balancing IN ('round','history')`) | Modo de equilíbrio da distribuição; default descreve lotes históricos (o comportamento antigo aproximava o nivelamento por carga acumulada). UI envia `'round'` para sorteios novos |
| `filters` | JSONB NULL | — | Snapshot da configuração de elegibilidade e participantes usada no sorteio |

Shape do `filters` (gravado pelo server, livre de PII além de user ids já presentes no schema):

```json
{
  "maxHumanCodings": 0,
  "assignmentFilter": "noActiveOfType",
  "batchFilter": { "exclude": ["<batch-uuid>"] },
  "manualDocIds": ["<doc-uuid>", "..."],
  "participantIds": ["<user-uuid>", "..."],
  "docSubsetSize": 50,
  "seed": 1234567890
}
```

Campos ausentes = filtro não usado. Colunas de deadline existentes (`deadline_mode`, `deadline_date`, `recurring_count`, `recurring_start`) ficam intocadas; sorteios novos gravam `deadline_mode = 'none'` e NULL nas demais.

RLS: tabela já coberta pelas policies existentes de coordenador; colunas novas não exigem índice (sem uso em policies nem em filtros frequentes).

## Entidades lidas (sem alteração)

### `documents`
Elegibilidade parte de `excluded_at IS NULL` (documentos excluídos nunca participam). Campos lidos: `id, external_id, title`.

### `responses`
Base do filtro por codificações: `humanCodingCount(doc)` = nº de `respondent_id` distintos com `is_latest = true` e `respondent_type = 'humano'`. Coberto pelo índice parcial `idx_responses_project_is_latest`.

### `assignments`
Base do filtro por status de atribuição, do filtro por lote (`batch_id`) e do conjunto preservado do sorteio. Estados: `pendente | em_andamento | concluido`; tipos sorteáveis: `codificacao | comparacao` (os tipos `auto_revisao`/`arbitragem` são ignorados pelo sorteio). Invariante: `UNIQUE(document_id, user_id, type)`.

### `project_members`
Fonte do pool de participantes (`user_id, role`); `participantIds` recebidos do client são validados contra esta tabela.

## Derivações (em memória, via `lottery-utils.ts`)

### `LotteryDocStats` (por documento ativo)

| Campo | Derivação |
|-------|-----------|
| `humanCodingCount` | respondentes humanos distintos com resposta `is_latest` |
| `activeAssignments.codificacao / .comparacao` | nº de atribuições ativas (`pendente` + `em_andamento`) por tipo; concluídas não contam aqui, mas entram em `hasAnyAssignmentEver` |
| `hasAnyAssignmentEver` | existe atribuição em qualquer status/tipo |
| `batchIds` | `batch_id` distintos das atribuições existentes do doc |

### Pipeline de elegibilidade (`filterEligibleDocs` — ordem fixa, interseção)

1. Ativos (`excluded_at IS NULL` — já garantido no fetch).
2. `manualDocIds` (se presente).
3. `maxHumanCodings` (se presente): `humanCodingCount <= max`.
4. `assignmentFilter`: `noActiveOfType` → sem atribuição `pendente`/`em_andamento` do tipo sorteado; `neverAssigned` → `!hasAnyAssignmentEver`.
5. `batchFilter`: `only` → `batchIds` contém o lote; `exclude` → interseção vazia com os lotes excluídos.
6. (Para tipo comparação, antes de tudo no server) exigência `humanCount latest >= min_responses_for_comparison` — preservada de `computeLottery`, compõe com os demais filtros (FR-011).

Após o pipeline, `computeLottery` aplica: vagas (`< researchersPerDoc` considerando o conjunto preservado do modo) → subconjunto aleatório (`docSubsetSize`) → distribuição via `distributeDocs` (pura — research.md D12).

### Distribuição (`distributeDocs` — por documento, em ordem embaralhada)

Para cada documento com vaga, candidatos = participantes sem atribuição preservada ou nova naquele documento e com capacidade restante (`docsPerResearcher`). Ordenação por chave composta:

1. **Carga corrente do modo de equilíbrio** — `round`: atribuições novas deste sorteio; `history`: carga acumulada (atribuições do tipo no conjunto preservado — em `append` inclui pendentes; em `replace` não, pois foram descartadas) + novas deste sorteio.
2. **Co-ocorrência** com quem já está no documento (variação de duplas — FR-014).
3. **Aleatório** — candidatos embaralhados antes do sort estável; a ordem de cadastro dos membros nunca decide (FR-019).

A carga corrente é atualizada a cada atribuição feita, então o critério primário vale documento a documento — é o que garante diferença máxima de 1 no modo `round` (SC-006) e o nivelamento no modo `history` (SC-007).

## Transições de estado relevantes

Sem mudanças nas máquinas de estado existentes. O modo apenas muda o que o sorteio pode deletar:

| Modo | `pendente` (do tipo) | `em_andamento`/`concluido` |
|------|----------------------|---------------------------|
| `append` | preservadas (contam para vagas, capacidade e anti-duplicidade) | preservadas |
| `replace` | deletadas e redistribuídas | preservadas |
