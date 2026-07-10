# Contracts — Documentos com exportação completa (004)

A feature não expõe API HTTP nova; os contratos são de Server Actions (Next.js) consumidas pelos componentes client do próprio app.

## 1. `getExportDataset(projectId: string)` — NOVA (`frontend/src/actions/export.ts`)

Server action `"use server"` (somente exports async — lição do PR #412). Gate: `requireCoordinator(projectId, ...)`; retorno fail-closed.

```ts
type ExportSheet = { headers: string[]; rows: string[][] };

type GetExportDatasetResult =
  | {
      projectName: string;
      documents: ExportSheet;   // 1 linha por documento; auxiliares (renomeadas em colisão) + document_text (o texto, se houver)
      responses: ExportSheet;   // estrutura atual do dataset "Respostas individuais"; rows vazio se não houver
      verdicts: ExportSheet;    // estrutura atual do dataset "Gabarito"; rows vazio se não houver
      csv: ExportSheet;         // visão unificada (controle + auxiliares + campos + reviewer_comments); SEM o inteiro teor
    }
  | { error: string };
```

Garantias:

- `csv.rows` contém: todas as respostas `is_latest`, todos os gabaritos, e uma linha `source="documento"` por documento sem resposta e sem gabarito — todo documento da base aparece ao menos uma vez em `documents.rows` e, se órfão, também em `csv.rows`.
- A base é composta apenas por documentos não excluídos (`excluded_at IS NULL`; exclusão pendente ainda conta como ativo); respostas e gabarito de documentos fora da base são descartados na montagem — nenhuma linha do arquivo referencia documento ausente de `documents.rows`.
- Cabeçalhos determinísticos: mesma base + mesmo schema ⇒ mesmos headers na mesma ordem (regras de colisão/ordenação em data-model.md §3.5).
- O inteiro teor do documento aparece **apenas** em `documents.rows` (coluna `document_text`, uma vez por doc, identificada por `metadata.text_column`); nunca no `csv` nem repetido por linha. Colunas auxiliares (demais colunas originais) seguem em `documents` e no `csv`.
- Valores já formatados como string (`formatExportValue`); o client só serializa (CSV manual com BOM / exceljs), sem lógica de domínio.
- Queries internas com colunas explícitas; `documents.metadata` é lido **apenas** aqui, nunca na listagem da página.

## 2. `uploadDocuments(projectId, documents, ...)` — ALARGADA (`frontend/src/actions/documents.ts`)

Assinatura inalterada; o shape de `documents[]` (tipo `UploadDoc`) ganha `metadata`:

```ts
type UploadDoc = {
  text: string;
  title?: string | null;
  external_id?: string | null;
  metadata?: {
    original_row: Record<string, string>;
    original_columns: string[];
    text_column?: string; // coluna de texto, para o export separar o inteiro teor
  } | null;
};
```

Compatibilidade: `metadata` opcional — chamadas antigas (ou docs sem CSV) seguem válidas com `null`. Os três modos (`add_new_only`, `replace_and_add`, `add_all`) persistem `metadata` sem transformação (o INSERT e a RPC `replace_and_add_documents` já o transportam hoje).

## 3. `buildDocs(csv, mapping)` — ALARGADA (`frontend/src/lib/upload-chunking.ts`)

Função pura client-side. Passa a retornar `UploadDoc[]` com `metadata` preenchido a partir da linha completa do papaparse:

- `original_row` = a linha inteira (`Record<string, string>`), células ausentes normalizadas para `""`;
- `original_columns` = `csv.columns` (ordem de `results.meta.fields`); cabeçalhos duplicados já chegam renomeados pelo papaparse 5.5.4 (`nome`, `nome_1`, … — comportamento verificado em 2026-07-10), então `original_columns` não contém duplicatas; um teste de regressão no fluxo de parse protege essa garantia;
- `text_column` = `mapping.text` (sempre não-vazio): marca a coluna de texto para o export separá-la das auxiliares;
- filtro existente mantido: linhas sem `row[mapping.text]?.trim()` continuam descartadas.

`chunkByBytes`/medição de bytes: passa a medir o documento serializado completo (incluindo metadata), mantendo `MAX_CHUNK_BYTES`/`MAX_DOCS_PER_CHUNK`. Fail-early de doc único acima do limite continua, sobre o tamanho real.

## 4. Remoções (contrato negativo)

- Rota `app/(app)/projects/[id]/reviews/export/` deixa de existir (acesso direto cai no not-found do Next).
- `ReviewsNav` deixa de listar "Exportar".
- `components/stats/ExportPanel.tsx` removido; nenhum outro consumidor existe (verificado por grep em 2026-07-10).
