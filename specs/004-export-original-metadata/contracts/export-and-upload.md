# Contracts — Documentos com exportação completa (004)

A feature não expõe API HTTP nova; os contratos são de Server Actions (Next.js) consumidas pelos componentes client do próprio app.

## 1. `getExportDataset(projectId: string)` — NOVA (`frontend/src/actions/export.ts`)

Server action `"use server"` (somente exports async — lição do PR #412). Gate: `requireCoordinator(projectId, ...)`; retorno fail-closed.

```ts
type ExportSheet = { headers: string[]; rows: string[][] };

type GetExportDatasetResult =
  | {
      projectName: string;
      documents: ExportSheet;   // 1 linha por documento; inclui colunas originais (renomeadas em colisão)
      responses: ExportSheet;   // estrutura atual do dataset "Respostas individuais"; rows vazio se não houver
      verdicts: ExportSheet;    // estrutura atual do dataset "Gabarito"; rows vazio se não houver
      csv: ExportSheet;         // visão unificada já composta (controle + originais + campos + reviewer_comments)
    }
  | { error: string };
```

Garantias:

- `csv.rows` contém: todas as respostas `is_latest`, todos os gabaritos, e uma linha `source="documento"` por documento sem resposta e sem gabarito — todo documento da base aparece ao menos uma vez em `documents.rows` e, se órfão, também em `csv.rows`.
- Cabeçalhos determinísticos: mesma base + mesmo schema ⇒ mesmos headers na mesma ordem (regras de colisão/ordenação em data-model.md §3.5).
- Valores já formatados como string (`formatExportValue`); o client só serializa (CSV manual com BOM / exceljs), sem lógica de domínio.
- Queries internas com colunas explícitas; `documents.metadata` é lido **apenas** aqui, nunca na listagem da página.

## 2. `uploadDocuments(projectId, documents, ...)` — ALARGADA (`frontend/src/actions/documents.ts`)

Assinatura inalterada; o shape de `documents[]` (tipo `UploadDoc`) ganha `metadata`:

```ts
type UploadDoc = {
  text: string;
  title?: string | null;
  external_id?: string | null;
  metadata?: { original_row: Record<string, string>; original_columns: string[] } | null;
};
```

Compatibilidade: `metadata` opcional — chamadas antigas (ou docs sem CSV) seguem válidas com `null`. Os três modos (`add_new_only`, `replace_and_add`, `add_all`) persistem `metadata` sem transformação (o INSERT e a RPC `replace_and_add_documents` já o transportam hoje).

## 3. `buildDocs(csv, mapping)` — ALARGADA (`frontend/src/lib/upload-chunking.ts`)

Função pura client-side. Passa a retornar `UploadDoc[]` com `metadata` preenchido a partir da linha completa do papaparse:

- `original_row` = a linha inteira (`Record<string, string>`), células ausentes normalizadas para `""`;
- `original_columns` = `csv.columns` (ordem de `results.meta.fields`);
- filtro existente mantido: linhas sem `row[mapping.text]?.trim()` continuam descartadas.

`chunkByBytes`/medição de bytes: passa a medir o documento serializado completo (incluindo metadata), mantendo `MAX_CHUNK_BYTES`/`MAX_DOCS_PER_CHUNK`. Fail-early de doc único acima do limite continua, sobre o tamanho real.

## 4. Remoções (contrato negativo)

- Rota `app/(app)/projects/[id]/reviews/export/` deixa de existir (acesso direto cai no not-found do Next).
- `ReviewsNav` deixa de listar "Exportar".
- `components/stats/ExportPanel.tsx` removido; nenhum outro consumidor existe (verificado por grep em 2026-07-10).
