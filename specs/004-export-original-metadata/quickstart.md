# Quickstart — validação manual (feature 004)

Pré-requisito: `cd frontend && npm run dev`, login como coordenador de um projeto de teste.

## 1. Preservação da linha original (US1)

1. Prepare um CSV com ≥5 colunas, ex.: `id_original,titulo,texto,tribunal,classe` — deixe alguma célula de `classe` vazia.
2. Em Configurações > Documentos, importe mapeando `texto`→texto, `titulo`→título, `id_original`→ID externo.
3. Confira no Supabase (ou via export, passo 2) que cada documento tem `metadata.original_row` com as 5 colunas (inclusive as mapeadas) e `metadata.original_columns` na ordem do CSV; célula vazia preservada como `""`.

## 2. Card de exportação (US2)

1. Abra Configurações > Documentos: o card de exportação aparece antes da lista, com escolha apenas de formato (CSV/XLSX) e preview de até 10 linhas.
2. Baixe o **CSV**: arquivo único; coluna `source` com valores `llm`/`codificacao`/`comparacao`/`documento`; colunas originais presentes e repetidas nas linhas do mesmo documento; abre com acentuação correta no Excel (BOM).
3. Baixe o **XLSX**: aba `Documentos` (1 linha/doc com colunas originais) + abas `Respostas` e `Gabarito` quando houver dados, com `document_id`/`document_title` para cruzamento.
4. Documento sem nenhuma resposta e sem gabarito: aparece no CSV como linha `source=documento` e na aba Documentos.
5. Colisão: importe um CSV com uma coluna chamada `source` ou com o nome de um campo do schema — no arquivo exportado ela vira `original_source` (etc.), consistente entre CSV e XLSX.

## 3. Documentos antigos (US3)

1. Em projeto com documentos importados antes da feature (`metadata IS NULL`), baixe CSV e XLSX: geração sem erro, colunas originais vazias para esses docs, dados da plataforma (id, título) presentes.

## 4. Acesso e remoções

1. Em Revisões, a aba "Exportar" não existe mais; acesso direto a `/projects/<id>/reviews/export` retorna not-found.
2. Como pesquisador (ou coordenador com "Ver como Pesquisador"), a aba Configurações não aparece e `/projects/<id>/config/documents` redireciona — Documentos e export seguem coordinator-only.

## 5. Gates automatizados

```bash
cd frontend && npm run typecheck && npx vitest run   # suíte completa; novos testes em lib/export, upload-chunking, actions/export
```

Performance (SC-007): em projeto de ~50 docs, o download completa em ≤10s.
