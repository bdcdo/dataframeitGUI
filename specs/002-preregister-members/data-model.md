# Data Model: Pré-registro de membros e vínculo de múltiplos e-mails

**Feature**: `002-preregister-members` | **Data**: 2026-06-11

## Mudanças em tabelas existentes

### `profiles` — nova coluna `activated_at`

```sql
ALTER TABLE profiles ADD COLUMN activated_at TIMESTAMPTZ;
UPDATE profiles SET activated_at = created_at;  -- backfill: existentes contam como ativos
```

- **Semântica**: `NULL` = membro pendente (nunca teve acesso autenticado). Preenchida uma única vez — pelo webhook `user.created` (signup real) ou pelo fallback em `getAuthUser()`.
- **Estados**: `pendente (activated_at IS NULL)` → `ativo (activated_at NOT NULL)`. Transição única, irreversível.
- Sem index novo: a coluna é lida via join `project_members → profiles`, já indexado.

## Tabela nova

### `member_email_links`

Registro de e-mails adicionais vinculados a um membro, com efeito restrito ao projeto (FR-013). Serve também de alias: quando a conta dona do e-mail existe (`linked_user_id` preenchido), ela acessa o projeto como `member_user_id`.

```sql
CREATE TABLE member_email_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,  -- identidade canônica no projeto
  email TEXT NOT NULL,                                                     -- sempre lowercase (normalizado na action)
  linked_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,          -- conta que usa o e-mail; NULL até existir
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, email)                                               -- FR-011: 1 e-mail → 1 membro por projeto
);

CREATE INDEX idx_member_email_links_project ON member_email_links(project_id);
CREATE INDEX idx_member_email_links_linked_user ON member_email_links(linked_user_id);  -- usado pelas funções RLS
CREATE INDEX idx_member_email_links_email ON member_email_links(email);                 -- lookup no webhook de signup
```

**Validações (na server action)**:

- Formato de e-mail + normalização lowercase/trim (FR-006).
- `member_user_id` deve ser membro do projeto.
- E-mail igual ao principal de outro membro do projeto → fluxo de unificação com confirmação (FR-009), não insert direto.
- Proibido vincular e-mail já presente em `member_email_links` do projeto (constraint + mensagem amigável, FR-011).

**Ciclo de vida**:

1. `linked_user_id IS NULL` — vínculo aguardando conta (vale como pré-registro do e-mail para o mesmo membro, clarificação Q2).
2. `linked_user_id = <profile>` — conta existente/criada; acesso ao projeto como `member_user_id` (RLS + effective member id).
3. Linha deletada — desvínculo (FR-012): acessos futuros pelo e-mail cessam; histórico intacto (nada referencia a linha).
4. Linha criada pela unificação (D4) com `linked_user_id = source` — registra que a conta source age como target no projeto; permanente.

## Funções e policies RLS

Migration nova estende as funções unificadas de `20260512000000_rls_unified_project_access.sql`:

```sql
-- Acesso ao projeto: membros, criadores e contas vinculadas
CREATE OR REPLACE FUNCTION auth_user_accessible_project_ids() ... 
  -- corpo atual UNION:
  SELECT project_id FROM member_email_links WHERE linked_user_id = clerk_uid();

-- Identidades que o usuário atual pode exercer num projeto (a própria + canônicas via alias)
CREATE FUNCTION auth_user_member_identity_ids(p_project_id UUID) RETURNS SETOF UUID ...
  SELECT clerk_uid()
  UNION
  SELECT member_user_id FROM member_email_links
   WHERE project_id = p_project_id AND linked_user_id = clerk_uid();
```

**Policies a atualizar** (trocar `X = clerk_uid()` por `X IN (SELECT auth_user_member_identity_ids(project_id))`):

- `responses` — "Users manage own responses" (`respondent_id`).
- `field_reviews` — policies de `self_reviewer_id` / `arbitrator_id`.
- `reviews` — "Reviewers manage reviews" (`reviewer_id`).

Policies por projeto (`project_id IN (...)`) seguem funcionando sem mudança, pois a função de acesso foi estendida. `member_email_links` em si: SELECT para membros do projeto (FR-015 — e-mails visíveis a todos os membros); INSERT/UPDATE/DELETE para coordenadores/criador (FR-014); mutações reais passam pelo admin client nas actions, como `project_members` hoje.

## Função de unificação

```sql
CREATE FUNCTION unify_project_members(
  p_project_id UUID, p_source_user_id UUID, p_target_user_id UUID
) RETURNS void SECURITY DEFINER ...
```

Numa transação, no escopo de `p_project_id` (ver D4 do research.md):

| Tabela | Coluna(s) migrada(s) source→target | Tratamento de colisão |
|--------|-----------------------------------|----------------------|
| `assignments` | `user_id` | `UNIQUE(document_id, user_id, type)`: se o target já tem a mesma (doc, type), deleta a do source |
| `responses` | `respondent_id` | recalcular `is_latest` por documento (a mais recente do conjunto fundido fica `true`) |
| `reviews` | `reviewer_id`, `resolved_by` | — |
| `field_reviews` | `self_reviewer_id`, `arbitrator_id` | unique por (response_field, …) se existir: target prevalece |
| `project_comments` | `author_id`, `resolved_by` | — |
| `difficulty_resolutions` / `error_resolutions` / `note_resolutions` | `resolved_by` | — |
| `response_equivalences` | `reviewer_id` | — |
| `llm_runs` | `started_by` | — |
| `assignment_batches` | `created_by` | — |
| `project_members` | deleta linha do source | papel/permissões do target prevalecem (spec, edge case de papéis) |
| `member_email_links` | re-aponta `member_user_id` do source para o target; insere alias (target, e-mail principal do source, linked=source) | mantém UNIQUE(project_id, email) |

A action que chama o RPC monta antes o **preview de confirmação** (FR-009): contagem de atribuições do source, documentos em que ambos têm resposta `is_latest` (impacto em comparações), papel resultante.

## Diagrama (resumo)

```
profiles (id, email, activated_at*)
   ▲ user_id                ▲ member_user_id        ▲ linked_user_id
project_members ──────  member_email_links* ────────┘
   (role, can_*)           (project_id, email UNIQUE por projeto)
                                 │ project_id
assignments / responses / reviews / field_reviews / ...  (identidade = sempre member_user_id canônico)
```

`*` = novo nesta feature. Invariante central: **dentro de um projeto, todo dado de trabalho referencia apenas o id canônico do membro**; contas vinculadas nunca aparecem em `assignments`/`responses` — a resolução acontece na entrada (effective member id) e no RLS.
