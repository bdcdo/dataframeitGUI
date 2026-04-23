# Fontes de comentários no dataframeitGUI

O dataframeitGUI consolida feedback de 6 fontes diferentes na página `/projects/[id]/reviews/comments` (ver `frontend/src/app/(app)/projects/[id]/reviews/comments/page.tsx:35-312`). A skill replica essas queries filtrando apenas os abertos.

## Visão geral

| Source | Tabela | Chave | "Aberto" quando | Campo atrelado? |
|---|---|---|---|---|
| `anotacao` | `project_comments` | `id` | `resolved_at IS NULL AND parent_id IS NULL` | opcional (`field_name`) |
| `review` | `reviews` | `id` | `resolved_at IS NULL AND comment IS NOT NULL` | sim (`field_name`) |
| `nota` | `responses` (humano) + `note_resolutions` | `response.id` | tem `justifications._notes` E `response_id NOT IN note_resolutions` | não (sempre `(geral)`) |
| `dificuldade` | `responses` (LLM) + `difficulty_resolutions` | `response.id` | tem `answers.llm_ambiguidades` E `response_id NOT IN difficulty_resolutions` E `is_current=true` | não (sempre `(geral)`) |
| `duvida` | `verdict_acknowledgments` + `reviews` | `(review_id, respondent_id)` | `resolved_at IS NULL AND status='questioned'` | sim (via `reviews.field_name`) |
| `sugestao` | `schema_suggestions` | `id` | `status='pending'` | sim (`field_name`) |

## Detalhes por fonte

### anotacao — `project_comments`

Anotação livre criada via modal "Nova nota". Pode ser:
- **Global** (sem `field_name` nem `document_id`)
- **Por campo** (`field_name`, sem `document_id`)
- **Por documento** (sem `field_name`, com `document_id`)
- **Específica** (ambos)

Suporta threads via `parent_id` — a skill só considera comentários raiz.

Resolver: `UPDATE project_comments SET resolved_at=now(), resolved_by=<user> WHERE id=<id>`.

### review — `reviews`

Comentário de comparação de respostas divergentes. Gerado no fluxo `/analyze/compare`. Sempre atrelado a `(document_id, field_name)`.

Campos extras carregados: `verdict`, `chosen_response_id`, `response_snapshot` (array de respondentes com suas respostas).

Resolver: `UPDATE reviews SET resolved_at=now(), resolved_by=<user> WHERE id=<id>`.

### nota — `responses.justifications._notes`

Pesquisador escreveu um texto livre ao codificar um documento. Só aparece se `justifications._notes` está preenchido. Não está atrelado a um field específico — pode cobrir vários.

Dedup especial: uma nota = um `response_id` (unique por pesquisador × documento).

Resolver: `INSERT INTO note_resolutions (project_id, response_id, resolved_by, note)`.
Reabrir: `DELETE FROM note_resolutions WHERE response_id=<id>`.

### dificuldade — `responses.answers.llm_ambiguidades`

Quando o projeto tem um campo especial `llm_ambiguidades` no schema, o LLM preenche com ambiguidades percebidas. Skill carrega apenas de responses com `is_current=true`.

Resolver: `INSERT INTO difficulty_resolutions (project_id, response_id, document_id, resolved_by, note)`.
Reabrir: `DELETE FROM difficulty_resolutions WHERE response_id=<id>`.

### duvida — `verdict_acknowledgments`

Pesquisador contestou um veredito no fluxo "Meu Gabarito". Join com `reviews` para pegar `field_name`, `document_id`, `verdict`.

Chave composta: `(review_id, respondent_id)`.

Resolver: `UPDATE verdict_acknowledgments SET resolved_at=now() WHERE review_id=<id> AND respondent_id=<id>`.

### sugestao — `schema_suggestions`

Pesquisador propôs mudança explícita no schema (via EditFieldDialog). JSONB `suggested_changes` pode conter `description`, `help_text`, `options`.

Aprovar aplica as mudanças + marca como resolvido. Ver `approveSchemaSuggestionWithEdits` em `frontend/src/actions/suggestions.ts:95-119`.

## Queries originais

Todas as 9 queries paralelas da `page.tsx`:

```ts
// 1. project — schema fields
supabase.from("projects").select("pydantic_fields, created_by").eq("id", id).single()

// 2. reviews — comparações
supabase.from("reviews")
  .select("id, document_id, field_name, verdict, comment, chosen_response_id, resolved_at, reviewer_id, created_at, response_snapshot")
  .eq("project_id", id)
  .not("comment", "is", null)

// 3. documents — para mapear title
supabase.from("documents").select("id, title, external_id").eq("project_id", id)

// 4. membership — pra saber se é coordenador
supabase.from("project_members").select("role").eq("project_id", id).eq("user_id", user.id)

// 5. responses humanas com justifications → notas
supabase.from("responses")
  .select("id, document_id, respondent_name, justifications, created_at")
  .eq("project_id", id).eq("respondent_type", "humano")
  .not("justifications", "is", null)

// 6. schema_change_log — histórico
supabase.from("schema_change_log")
  .select("...")
  .eq("project_id", id)
  .order("created_at", { ascending: false })
  .limit(50)

// 7. schema_suggestions — sugestões
supabase.from("schema_suggestions")
  .select("id, field_name, suggested_changes, reason, status, resolved_at, created_at, profiles!suggested_by(email)")
  .eq("project_id", id)

// 8. responses LLM com llm_ambiguidades → dificuldades
supabase.from("responses")
  .select("id, document_id, answers, respondent_name, created_at")
  .eq("project_id", id).eq("respondent_type", "llm").eq("is_current", true)

// 9. difficulty_resolutions — já resolvidos
supabase.from("difficulty_resolutions")
  .select("response_id, resolved_at").eq("project_id", id)

// 10. project_comments — anotações
supabase.from("project_comments")
  .select("id, document_id, field_name, author_id, body, parent_id, resolved_at, resolved_by, created_at, profiles!author_id(email)")
  .eq("project_id", id).is("parent_id", null)

// 11. verdict_acknowledgments — dúvidas
supabase.from("verdict_acknowledgments")
  .select("review_id, respondent_id, comment, resolved_at, created_at, reviews!inner(id, project_id, document_id, field_name, verdict)")
  .eq("status", "questioned").not("comment", "is", null)
  .eq("reviews.project_id", id)

// 12. note_resolutions — notas já resolvidas
supabase.from("note_resolutions").select("response_id, resolved_at").eq("project_id", id)
```

A skill reaproveita essas queries em `scripts/comentarios-relatorio/fetch-open-comments.ts`, mas filtra só os abertos.

## Payload dos comentários no JSON

Cada comentário vira um `OpenComment`:

```ts
interface OpenComment {
  id: string;              // "review-<uuid>", "nota-<uuid>", "duvida-<reviewId>-<respondentId>"
  source: "review" | "nota" | "sugestao" | "dificuldade" | "duvida" | "anotacao";
  rawId: string;           // id real para mutations
  fieldName: string;       // nome do field Pydantic ou "(geral)"
  documentId: string | null;
  documentTitle: string | null;
  text: string;
  author: string;
  createdAt: string;       // ISO
  extra: Record<string, unknown>;  // metadata source-específico
}
```

### `extra` por source:

- **review**: `{ verdict, chosenResponseId, responseSnapshot, fieldType, fieldOptions }`
- **nota**: `{ responseId, respondentId }`
- **sugestao**: `{ suggestedChanges, changedKeys, status, currentField }`
- **dificuldade**: `{ responseId, documentId }`
- **duvida**: `{ reviewId, respondentId, verdict, fieldType, fieldOptions }`
- **anotacao**: `{ fieldType, fieldOptions }`
