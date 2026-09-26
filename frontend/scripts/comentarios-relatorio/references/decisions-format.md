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

O shape de cada campo é o `PydanticField` de `frontend/src/lib/types.ts` (id, name, type, options, description, help_text, target, required, subfields, subfield_rule, allow_other, condition, justification_prompt). Não inclua `hash` — o script recalcula.

Mudar `help_text` aqui vale como "Só esclarece": o script não faz a pergunta que a UI faz no save e não sobe `question_revision`, e o hash do campo não muda por causa da instrução. Para "Muda como responder", grave no campo `question_revision` igual ao atual mais 1 (ou `1`, se o campo não tiver). Preserve o `question_revision` que veio de `fetch-open-comments.ts`: tirá-lo devolve o campo ao hash anterior à revisão.

Todo campo leva `id`: UUID com hífens e em minúsculas (`FIELD_ID_PATTERN` em `frontend/src/lib/pydantic-field.ts`). Campo existente mantém o `id` que veio de `fetch-open-comments.ts`, porque é ele que identifica o campo através de renomeações. Campo novo recebe um UUID v4 novo. Sem `id`, o script recusa o arquivo com "newFields não corresponde ao contrato canônico".

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

Todas as resoluções são validadas contra o `projectId` (ids de outro projeto retornam erro por item), e `nota`/`dificuldade` são idempotentes — pares já resolvidos são ignorados via `UNIQUE(project_id, response_id)`. **Importante**: idempotente aqui significa que o par existente **não é alterado** — se um `nota`/`dificuldade` já resolvido reaparecer em `decisions.json` com um `note` diferente do que já está gravado, essa nota nova é descartada silenciosamente (o upsert ignora o conflito) e o item volta com `result.detail` indicando "já resolvido anteriormente — nota não foi alterada" em vez de sugerir que a nota nova foi persistida.

## Semântica de `--dry-run` / `--yes`

Sem `--yes`, **nada é gravado**: schema e resoluções rodam como preview (o output mostra o que seria feito). `--dry-run` é o alias explícito do mesmo comportamento. Só `--yes` (sem `--dry-run`) executa os writes — schema, resoluções e `summaryNote`.

O preview roda os mesmos guards de posse (`projectId`) e checagens de existência que o `--yes` — só a escrita em si (UPDATE/INSERT/UPSERT) é trocada por um SELECT equivalente. Isso significa que `exclusao` já aparece como erro no preview (idêntico ao que `--yes` faria), e um `rawId`/`reviewId`/`respondentId` de outro projeto ou malformado também falha no preview, em vez de aparecer como "sucesso" e só falhar quando rodado com `--yes`.

## Cache da GUI após uma mudança de schema

Este script roda fora do runtime Next (processo `tsx` standalone) e por isso não pode chamar `revalidatePath`/`revalidateTag` como `saveSchemaFromGUI` faz. Depois de um `--yes` que aplica mudança de schema, a GUI pode continuar mostrando o schema/versão anteriores por até ~60s (TTL do cache de `project-{id}-progress`) até o cache expirar naturalmente ou outra mutação pela própria GUI revalidar as mesmas rotas/tag. Se precisar ver o resultado imediatamente numa página específica, recarregue com Ctrl+Shift+R.
