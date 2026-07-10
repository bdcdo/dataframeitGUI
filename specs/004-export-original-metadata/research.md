# Research — Documentos com exportação completa (004)

Phase 0 do `/speckit-plan`. Nenhum NEEDS CLARIFICATION restou no Technical Context; as decisões abaixo resolvem as incógnitas de design levantadas pela spec e pela exploração do código em 2026-07-10.

## D1. Persistência da linha original: reusar `documents.metadata JSONB`

**Decision**: armazenar a linha original em `documents.metadata` com o shape `{ original_row: Record<string, string>, original_columns: string[] }`. Sem migration.

**Rationale**: a coluna existe desde `001_initial_schema.sql:83`, nunca foi populada, e o pipeline inteiro já a transporta — `uploadDocuments` insere `metadata: doc.metadata || null` nos três modos (`add_new_only`, `replace_and_add`, `add_all`) e a RPC `replace_and_add_documents` (`20260629120000_atomic_replace_rpcs.sql`) já atualiza `metadata` via `jsonb_to_recordset`. O array `original_columns` é necessário porque **jsonb não preserva ordem de chaves** (Postgres normaliza objetos jsonb); sem ele, a regra da spec "colunas originais em ordem estável e previsível" não seria satisfazível com a ordem do CSV. O aninhamento sob `original_row` (em vez de espalhar a linha na raiz do objeto) mantém `metadata` extensível para usos futuros sem colisão de chaves.

**Alternatives considered**: (a) coluna nova `original_row JSONB` — exigiria migration que a spec explicitamente dispensa, sem ganho sobre a coluna ociosa; (b) tipo `json` (não `jsonb`), que preserva ordem — exigiria migration de tipo e perderia operadores/índices jsonb; (c) ordem alfabética derivada das chaves no export — estável, mas surpreende o usuário que espera a ordem da planilha; o custo do array (~algumas centenas de bytes/doc) é aceitável.

## D2. Reimportação e duplicatas

**Decision**: nenhum mecanismo novo. `replace_and_add` já sobrescreve `metadata` (linha nova prevalece, como a spec pede); `add_new_only` ignora duplicatas (dados preservados anteriores ficam intactos); o filtro defensivo `filterActiveExternalIdConflicts` não é afetado (opera sobre `external_id`).

**Rationale**: o edge case da spec ("reimportações substituem a linha original; duplicatas ignoradas permanecem inalteradas") é satisfeito pelo comportamento transacional existente sem código novo.

## D3. Payload de upload: medição de bytes passa a incluir o metadata

**Decision**: `chunkByBytes`/`utf8Bytes` em `frontend/src/lib/upload-chunking.ts` passam a medir o documento serializado completo (texto + título + external_id + metadata), não apenas `d.text`. Limites `MAX_CHUNK_BYTES = 3_500_000` e `MAX_DOCS_PER_CHUNK = 500` permanecem.

**Rationale**: a linha original pode dobrar o tamanho do payload por documento (o texto aparece duas vezes: em `text` e em `original_row[colunaDeTexto]`). Sem incluir o metadata na medição, um chunk "dentro do limite" estouraria o cap de ~4,5MB de Server Actions da Vercel (`FUNCTION_PAYLOAD_TOO_LARGE` — regressão que o chunking existe para evitar). O fail-early de documento único acima do limite continua valendo, agora sobre o tamanho real.

**Alternatives considered**: excluir do `original_row` a coluna mapeada para texto e reconstituí-la no export a partir de `documents.text` — reduziria payload, mas quebra FR-002 (a linha preservada inclui as colunas mapeadas) e cria acoplamento entre export e mapeamento histórico (qual coluna era o texto? teria de ser registrado). Rejeitada: viola a regra de manter o estado ruim irrepresentável — `original_row` completo é autossuficiente.

## D4. Montagem do export: funções puras em `lib/export/` + server action sob demanda

**Decision**: extrair a lógica de montagem hoje embutida no RSC `reviews/export/page.tsx` (datasets individual/gabarito, auto-fill de concordância com `min_responses_for_comparison`, formatação de veredicto `[AMBIGUO]`/`[PULAR]`, `formatExportValue`) para módulo puro `frontend/src/lib/export/`, consumido por uma server action nova `getExportDataset(projectId)` (`frontend/src/actions/export.ts`), gated por `requireCoordinator`. O `ExportCard` (client) chama a action sob demanda e gera o arquivo no browser.

**Rationale**: (a) testabilidade — Princípio V exige testes para lógica nova/movida em `lib/` e `actions/`, e função pura testa com fixtures sem mock de framework; (b) velocidade — montar o dataset no RSC da página Documentos penalizaria todo carregamento da página com 3+ queries pesadas (incluindo `metadata` de todos os docs); sob demanda, a página continua leve e o custo é pago só quando o usuário exporta/pré-visualiza; (c) o gate `requireCoordinator` na action espelha o gate de rota do `config/layout.tsx` (defesa em profundidade barata).

**Alternatives considered**: (a) montar no RSC como hoje — rejeitada pelo custo em toda navegação à página (Princípio II); (b) endpoint FastAPI — violaria Princípio VIII (FastAPI só para LLM/Pydantic); (c) geração server-side do arquivo — FR-017 proíbe nesta versão. Nota de risco conhecida: arquivo `"use server"` só pode exportar funções async (lição do PR #412 — export síncrono quebra o deploy silenciosamente e nenhum gate local pega); as funções puras vivem em `lib/export/` justamente fora do módulo `"use server"`.

## D5. Formato dos arquivos e colisão de cabeçalhos

**Decision**:

- **CSV unificado**: colunas de controle (`document_id`, `document_title`, `respondent`, `respondent_type`, `source`) + colunas originais (ordem D1) + campos do schema + `reviewer_comments`. `source` ∈ {`llm`, `codificacao`, `comparacao`, `documento`}; linha `documento` apenas para documentos sem resposta e sem gabarito; colunas originais repetidas em todas as linhas do mesmo documento.
- **XLSX**: 3 abas — `Documentos` (uma linha por documento: identificadores + colunas originais), `Respostas` e `Gabarito` (estruturas atuais, sem colunas originais, com `document_id`/`document_title` para cruzamento). Abas de respostas/gabarito só aparecem quando há dados.
- **Colisão**: coluna original que colidir com coluna de controle ou campo do schema ganha prefixo `original_` (só em colisão; se `original_x` também existir, sufixa `_2`, `_3`...). Regra aplicada de forma idêntica no CSV e na aba Documentos.
- **Ordem das colunas originais**: união das `original_columns` de todos os docs, percorridos por `created_at` ascendente, preservando a ordem interna de cada doc e ignorando colunas já vistas.

**Rationale**: mantém o assumption da spec ("colunas aparecem exatamente, salvo ajuste por colisão") — renomear tudo com prefixo criaria nomes diferentes do CSV do usuário sem necessidade. A união ordenada por `created_at` dá ordem determinística mesmo com imports sucessivos de schemas de planilha diferentes. BOM + escaping manual do CSV e exceljs dinâmico são herdados do `ExportPanel` atual (comportamento já validado em produção).

**Alternatives considered**: prefixo `original_` em todas as colunas (estável mas polui nomes); bloco posicional sem renomear (ambíguo para ferramentas que indexam por nome, ex.: pandas com colunas duplicadas).

## D6. UI: card no topo de Documentos; remoção da rota antiga

**Decision**: novo `ExportCard.tsx` em `components/documents/` renderizado por `config/documents/page.tsx` antes da lista. Escolha única de formato (CSV/XLSX), botão de download, preview de até 10 linhas (padrão herdado do `ExportPanel`), estados de loading/erro/vazio. Remoções: entrada "Exportar" em `ReviewsNav.tsx`, diretório `app/(app)/projects/[id]/reviews/export/`, componente `components/stats/ExportPanel.tsx`.

**Rationale**: FR-005/FR-005a/FR-006. O smoke e2e do pre-push não navega para `reviews/export` (verificado em `frontend/e2e/*.spec.ts`), então a remoção da rota não quebra o gate. Acesso permanece coordinator-only via `config/layout.tsx` — decisão de clarificação 2026-07-10 (US3 removida; regressão de acesso dos pesquisadores aceita).

**Alternatives considered**: manter a rota antiga como redirect — rejeitada (dois caminhos para a mesma coisa; a decisão de clarificação pede remoção).

## D7. Acesso: nenhuma mudança de permissão

**Decision**: nenhuma alteração em RLS, `config/layout.tsx`, `ProjectTabs` ou `getProjectAccessContext`.

**Rationale**: com a US3 removida (clarificação 2026-07-10), o gate existente de coordenador já cobre todos os requisitos. A RLS de `documents` permite SELECT a membros (`Members view documents`), mas isso é irrelevante para esta feature — o bloqueio de UI é o gate de rota, que permanece. Registro honesto: pesquisadores perdem o acesso ao export que a aba de Revisões dava (o layout de Revisões só exige login); regressão aceita explicitamente pelo usuário.
