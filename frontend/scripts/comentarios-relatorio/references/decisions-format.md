# Formato do decisions.json (apply-decisions.ts)

Contrato do arquivo consumido por `apply-decisions.ts`. O JSON normalmente é gerado pelo Claude a partir do `.md` anotado pelo usuário (fluxo da skill comentarios-relatorio), mas nada impede autoria manual — desde que respeite este shape.

## Estrutura

```jsonc
{
  "projectId": "<uuid do projeto>",
  "changedBy": "<uuid do usuário>",      // opcional; default: created_by do projeto
  "newFields": [ /* PydanticField[] */ ], // lista COMPLETA pós-edições (não é um delta)
  "resolutions": [ /* ver variantes abaixo */ ],
  "summaryNote": "texto opcional"         // vira project_comment já resolvido
}
```

## `newFields` — lista completa, nunca delta

`newFields` substitui `projects.pydantic_fields` por inteiro: campos ausentes são tratados como **removidos** (entry "campo removido" no `schema_change_log`). Portanto, parta sempre do `fields` retornado por `fetch-open-comments.ts` e aplique as edições sobre ele.

O shape de cada campo é o `PydanticField` de `frontend/src/lib/types.ts` (name, type, options, description, help_text, target, required, subfields, subfield_rule, allow_other, condition, justification_prompt). Não inclua `hash` — o script recalcula.

**Guarda anti-wipe**: `newFields: []` sobre projeto que já tem schema é rejeitado com erro (espelha `saveSchemaFromGUI`). Remoção total de campos, se um dia for legítima, é feita pela UI.

## `resolutions` — variantes por source

Os `rawId`/ids vêm do JSON do `fetch-open-comments.ts` (campo `rawId` de cada comentário, salvo indicação em contrário).

| source | shape | efeito |
|--------|-------|--------|
| `anotacao` | `{ "source": "anotacao", "rawId": "<project_comment id>" }` | UPDATE `project_comments` (resolved_at/by) |
| `review` | `{ "source": "review", "rawId": "<review id>" }` | UPDATE `reviews` (resolved_at/by) |
| `nota` | `{ "source": "nota", "rawId": "<response id>", "note": "opcional" }` | INSERT `note_resolutions` |
| `dificuldade` | `{ "source": "dificuldade", "rawId": "<response id>", "documentId": "<doc id>", "note": "opcional" }` | INSERT `difficulty_resolutions` |
| `duvida` | `{ "source": "duvida", "reviewId": "<review id>", "respondentId": "<user id>" }` | UPDATE `verdict_acknowledgments` |
| `sugestao` | `{ "source": "sugestao", "rawId": "<suggestion id>", "action": "approved" \| "rejected", "rejectionReason": "opcional" }` | UPDATE `schema_suggestions` |

Atenção ao caso `duvida`: o `rawId` do fetch é composto (`"reviewId|respondentId"`) — **não o parseie**; use `extra.reviewId` e `extra.respondentId` do próprio comentário, que já vêm separados.

Pedidos de exclusão de documento (source `exclusao` no fetch) **não são resolvíveis por aqui**: a aprovação exige `excludeDocuments` (soft delete + auditoria), fluxo da plataforma. Se aparecerem em `resolutions`, o script devolve erro por item sem tocar o banco.

Todas as resoluções são validadas contra o `projectId` (ids de outro projeto retornam erro por item), e `nota`/`dificuldade` são idempotentes — pares já resolvidos são ignorados via `UNIQUE(project_id, response_id)`.

## Semântica de `--dry-run` / `--yes`

Sem `--yes`, **nada é gravado**: schema e resoluções rodam como preview (o output mostra o que seria feito). `--dry-run` é o alias explícito do mesmo comportamento. Só `--yes` (sem `--dry-run`) executa os writes — schema, resoluções e `summaryNote`.
