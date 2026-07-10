# Data Model — Documentos com exportação completa (004)

Phase 1 do `/speckit-plan`. Sem migration: a única mudança de dados é passar a popular uma coluna existente.

## 1. `documents.metadata` (coluna JSONB existente, passa a ser populada)

```jsonc
{
  "original_row": {            // Record<string, string> — a linha do CSV como lida pelo papaparse (header: true)
    "id_original": "0001234-56.2024.8.26.0000",
    "titulo": "Apelação Cível ...",
    "texto": "Inteiro teor ...",
    "tribunal": "TJSP",
    "classe": ""               // célula vazia preservada como "" (coluna existe, sem valor)
  },
  "original_columns": ["id_original", "titulo", "texto", "tribunal", "classe"]  // ordem do CSV
}
```

Regras e invariantes:

- `original_row` contém **todas** as colunas da linha, inclusive as mapeadas para `text`/`title`/`external_id` (FR-002). Valores são os textuais do parse (`Record<string, string>`); células ausentes em linhas curtas normalizam para `""`.
- `original_columns` existe porque jsonb não preserva ordem de chaves; é a fonte da ordenação no export. Invariante: `original_columns` ⊇ chaves de `original_row` na prática (ambos vêm de `results.meta.fields` e da própria linha); o export usa `original_columns` como ordem e `original_row` como valores.
- `metadata IS NULL` ⇒ documento importado antes da feature (ou criado por caminho sem CSV). O export trata como "colunas originais vazias" (FR-011); nenhum backfill (FR-018).
- Reimportação `replace_and_add` sobrescreve `metadata` (linha nova prevalece); `add_new_only` não toca documentos existentes.

## 2. Tipos TypeScript (frontend)

```ts
// lib/upload-chunking.ts / actions/documents.ts
export interface DocumentMetadata {
  original_row: Record<string, string>;
  original_columns: string[];
}

// UploadDoc (hoje Pick<DocumentRow, "text" | "title" | "external_id">) passa a incluir metadata
export type UploadDoc = Pick<DocumentRow, "text" | "title" | "external_id" | "metadata">;
```

`DocumentRow.metadata` já existe como `Record<string, unknown>` opcional e já flui até o INSERT/RPC — o alargamento é só no shape que o client monta.

## 3. Dataset de export (retorno de `getExportDataset` — ver contracts/)

Três visões montadas server-side por funções puras de `lib/export/`:

### 3.1 Visão Documentos (base da aba XLSX "Documentos" e das linhas `source=documento` do CSV)

| Coluna | Origem |
|---|---|
| `document_id` | `documents.external_id \|\| documents.id` (regra atual do export) |
| `document_title` | `documents.title` |
| `<colunas originais...>` | `metadata.original_row`, ordenadas pela união de `original_columns` (docs por `created_at` asc, primeira aparição vence) |

### 3.2 Visão Respostas individuais (estrutura atual preservada)

`document_id, document_title, respondent, respondent_type, source, <campos exportáveis do schema...>` — uma linha por resposta `is_latest`; `source` = `llm` \| `codificacao`. Campos exportáveis: `pydantic_fields` com `target` ∉ {`llm_only`, `none`}.

### 3.3 Visão Gabarito (estrutura atual preservada)

`document_id, document_title, source, <campos...>, reviewer_comments` — uma linha por documento com veredicto ou concordância; `source` = `comparacao`. Prioridade por campo: veredicto explícito do revisor > auto-fill de concordância (só com `respostas ≥ min_responses_for_comparison`; multi compara conjuntos, demais via `normalizeForComparison`) > vazio. Formatação de veredicto mantida (`ambiguo`→`[AMBIGUO]`, `pular`→`[PULAR]`, multi JSON juntado com `; `).

### 3.4 Composição final

- **CSV unificado**: cabeçalho = controle ∪ colunas originais ∪ campos do schema ∪ `reviewer_comments`. Linhas: todas as respostas (3.2) + todos os gabaritos (3.3) + uma linha `source=documento` para cada documento sem resposta E sem gabarito. Colunas originais repetidas em toda linha do documento; BOM `﻿` + escaping manual (herdados do ExportPanel).
- **XLSX**: aba `Documentos` (3.1, sempre presente), aba `Respostas` (3.2, se houver), aba `Gabarito` (3.3, se houver). Sem colunas originais fora da aba Documentos.

### 3.5 Colisão e ordenação (regras determinísticas)

- Colisão: coluna original com nome igual a coluna de controle ou campo do schema → `original_<nome>`; persiste colisão → sufixo numérico `_2`, `_3`… Mesmo renomeio no CSV e na aba Documentos.
- Ordem das colunas originais: união preservando ordem — itera documentos por `created_at` asc, dentro de cada doc segue `original_columns`, ignora vistas.
- Valores complexos: `formatExportValue` atual (array→`join("; ")`, objeto→`k: v; ...`, null→`""`).

## 4. Entidades não alteradas

`responses`, `reviews`, `projects`, RLS policies, RPC `replace_and_add_documents` (já transporta metadata), índices — sem mudança. FastAPI/backend não é tocado.
