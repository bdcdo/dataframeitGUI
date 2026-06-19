# Deduplicação de documentos — projeto Zolgensma (2026-06)

Diagnóstico e plano de execução do dedup dos documentos duplicados do projeto Zolgensma (`0c6394da`). O script que executa este plano é `frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs`. Contexto: surgiu durante a correção de OCR dos pareceres escaneados do RJ (issue bdcdo/dataframeit#110).

## Resumo

O projeto tem **245 documentos / 214 `external_id` distintos → 31 `external_id` duplicados**. A duplicação vem de **re-importações que rodam `INSERT` puro** (`uploadDocuments`, modo default `add_all`, em `frontend/src/actions/documents.ts`), porque `documents` não tem `UNIQUE(project_id, external_id)` — só índices não-únicos (`001_initial_schema.sql`). Duas ondas: 29 pares `2026-05-05 + 2026-06-11` e 2 pares `2026-03-16 + 2026-05-05`.

Histórico reconstruído pelos metadados de exclusão: import 05-05 → triagem 05-08 excluiu 46 docs ("fora do escopo: medicamento != onasemnogeno") → re-import 06-11 trouxe 29 de volta como cópias **ativas** → a equipe codifica/revisa as cópias ativas ao vivo. Decisão do coordenador (2026-06-18): esses pareceres (nusinersena/AME) **estão no escopo agora**; recuperar o trabalho humano **sem perder respostas**.

## Modelo de dados (o que o merge respeita)

Tabelas com FK `document_id` e regra `ON DELETE`:

| Tabela | ON DELETE | UNIQUE relevante |
|---|---|---|
| `responses` | CASCADE | nenhuma (versiona por `is_latest`, humano/llm) |
| `field_reviews` | CASCADE | **(document_id, field_name)**; aponta `human_response_id`/`llm_response_id` |
| `assignments` | CASCADE | **(document_id, user_id, type)** |
| `reviews` | CASCADE | — |
| `response_equivalences` | CASCADE | aponta `response_a_id`/`response_b_id` |
| `error_resolutions` | CASCADE | — |
| `difficulty_resolutions` | CASCADE | — |
| `project_comments` | SET NULL | — |

Como quase tudo é `ON DELETE CASCADE`, um `DELETE` no documento apaga os filhos. Por isso o merge **move** (`UPDATE document_id`) tudo para a sobrevivente e usa **soft-delete** (`documents.excluded_at`) na perdedora — reversível, sem cascata.

**Garantia "não perder responses":** `responses` não tem UNIQUE, então todas as respostas da perdedora migram para a sobrevivente. As referências de `field_reviews`/`response_equivalences` são por `response_id` (UUID), que não muda na migração — continuam válidas. Conflitos de UNIQUE (`field_reviews` por `field_name`, `assignments` por `user_id+type`) fazem a linha conflitante da perdedora **não ser movida** (fica na cópia soft-deletada + no backup JSON), nunca deletada.

## Manifesto (recalculado ao vivo pelo script)

Sobrevivente = cópia com maior trabalho humano (peso `field_reviews`×100, humanas×10, equiv×5, errRes×3, assign×2, comments×1; empate → ativa → mais antiga). Snapshot de 2026-06-18: **14 MERGE, 17 NOOP**. Os NOOP são pares cuja perdedora já está excluída e só tem resposta LLM (nada humano a recuperar) — incluindo 1663-2025, já deduplicado manualmente.

Casos com conflito a resolver no merge:
- **0647-2025**: as duas cópias ativas e muito trabalhadas (sobrevivente 03-16 com 15 field_reviews; perdedora 05-05 com 8). 7 field_reviews e 3 assignments em conflito ficam na perdedora (preservados, soft-deletada).
- **1210-2017**: sobrevivente é a cópia 06-11 (frev6 > frev4 da 05-05); 4 field_reviews em conflito.

> Atenção: em vários pares a cópia **ativa** vem ganhando `field_reviews` ao vivo (a equipe pode estar refazendo a revisão na cópia ativa). Por isso o script **recomputa o manifesto imediatamente antes de executar** e tem um *guard* que aborta `--apply` se houver atividade recente.

## Procedimento de execução (em janela de freeze)

1. Combinar uma **janela sem codificação ativa** com a equipe (o script aborta `--apply` se detectar atividade nos últimos `--quiet-min` minutos; default 30).
2. Dry-run: `node frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs` — conferir o plano.
3. Opcional, um par por vez: `--only NATJUS-FEDERAL-0803-2019`.
4. Executar: `node frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs --apply` (acrescente `--reconcile-latest` para deixar uma única resposta `is_latest` por tipo na sobrevivente).
5. Backups por par em `frontend/scripts/dedup-backups/<external_id>.json` (gitignored). Soft-delete reversível: restaurar via `excluded_at=null` + re-`UPDATE document_id` a partir do backup.
6. Verificar: o script confere que o nº de `responses` na sobrevivente == soma das duas cópias antes (zero perda).

## Fix de causa raiz (follow-up, fora deste PR)

Para impedir recorrência:
- **Migration**: `CREATE UNIQUE INDEX ... ON documents(project_id, external_id) WHERE external_id IS NOT NULL AND excluded_at IS NULL;` — permite uma cópia excluída + uma ativa (compatível com soft-delete), mas bloqueia duas ativas com o mesmo `external_id`.
- **Import** (`uploadDocuments`): default para `add_new_only`/upsert quando `external_id` casa, ou tratar a violação do índice de forma graciosa.
