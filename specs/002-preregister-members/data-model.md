# Data Model: Pré-registro de membros e vínculo de múltiplos e-mails

**Feature**: `002-preregister-members` | **Data**: 2026-06-11

## Mudanças em tabelas existentes

### `profiles` — nova coluna `activated_at`

```sql
ALTER TABLE profiles ADD COLUMN activated_at TIMESTAMPTZ;
UPDATE profiles SET activated_at = created_at;  -- backfill: existentes contam como ativos
```

- **Semântica**: `NULL` = membro pendente (nunca teve acesso autenticado). Preenchida uma única vez — pelo webhook `user.created` (signup real; quando o signup é de um e-mail vinculado, o webhook ativa também o `member_user_id` canônico do vínculo) ou pela action idempotente `completeAccess()` durante o reparo explícito do acesso. `getAuthUser()` permanece read-only.
- **Estados**: `pendente (activated_at IS NULL)` → `ativo (activated_at NOT NULL)`. Transição única, irreversível.
- Sem index novo: a coluna é lida via join `project_members → profiles`, já indexado.

## Tabela nova

### `member_email_links`

Registro de e-mails adicionais vinculados a um membro, com efeito restrito ao projeto (FR-013). Serve também de alias: quando a conta dona do e-mail existe (`linked_user_id` preenchido), ela acessa o projeto como `member_user_id`.

```sql
CREATE TABLE member_email_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_user_id UUID NOT NULL,                                            -- identidade canônica no projeto
  email TEXT NOT NULL,                                                     -- sempre lowercase (normalizado na action)
  linked_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,          -- conta que usa o e-mail; NULL até existir
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT member_email_links_distinct_alias_check
    CHECK (linked_user_id IS NULL OR linked_user_id <> member_user_id),
  UNIQUE (project_id, email),                                              -- FR-011: 1 e-mail → 1 membro por projeto
  FOREIGN KEY (project_id, member_user_id)
    REFERENCES project_members(project_id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_member_email_links_project ON member_email_links(project_id);
CREATE UNIQUE INDEX member_email_links_linked_user_project_key
  ON member_email_links(linked_user_id, project_id)
  WHERE linked_user_id IS NOT NULL;
CREATE INDEX idx_member_email_links_email ON member_email_links(email);                 -- lookup no webhook de signup
```

**Invariantes no schema**:

- Cada conta (`linked_user_id`) resolve para no máximo um membro canônico por projeto; a mesma conta pode resolver para membros diferentes em projetos diferentes.
- `member_user_id` deve existir em `project_members` no mesmo projeto. A FK simples anterior para `profiles(id)` é redundante: a FK composta já chega ao profile por `project_members.user_id` e faz cascade quando a membership canônica é removida.
- Self-alias (`linked_user_id = member_user_id`) é inválido.
- A identidade canônica é terminal: um UUID não pode aparecer simultaneamente como `linked_user_id` e `member_user_id` no mesmo projeto. Um trigger serializado por projeto torna cadeias e ciclos irrepresentáveis, inclusive sob inserts concorrentes, sem impedir que várias contas apontem para o mesmo membro terminal.

**Validações na server action**:

- Formato de e-mail + normalização lowercase/trim (FR-006).
- `member_user_id` deve ser membro do projeto.
- E-mail igual ao principal de outro membro do projeto → fluxo de unificação com confirmação (FR-009), não insert direto.
- Proibido vincular e-mail já presente em `member_email_links` do projeto (constraint + mensagem amigável, FR-011).

**Ciclo de vida**:

1. `linked_user_id IS NULL` — vínculo aguardando conta (vale como pré-registro do e-mail para o mesmo membro, clarificação Q2).
2. `linked_user_id = <profile>` — conta existente/criada; acesso ao projeto como `member_user_id` (RLS + effective member id).
3. Linha deletada — desvínculo (FR-012): acessos futuros pelo e-mail cessam; histórico intacto (nada referencia a linha).
4. Linha criada pela unificação (D4) com `linked_user_id = source` — registra que a conta source age como target no projeto; permanente.

Em qualquer estado resolvido, existe exatamente uma identidade de trabalho por conta e projeto. Se houver alias, papel, `can_resolve` e policies de own rows vêm somente da membership canônica; a membership bruta não soma permissões. Ownership em `projects.created_by` e autoria/auditoria continuam ligados à conta autenticada quando o respectivo contrato pede o id bruto.

## Funções e policies RLS

As funções RLS resolvem a membership canônica antes de calcular acesso ou papel:

```sql
-- Exatamente uma identidade: canônica se houver alias; bruta caso contrário.
auth_user_member_identity_ids(project_id)

-- Membership/papel/flag vêm dessa identidade única.
auth_user_project_ids()
auth_user_coordinator_project_ids()
auth_user_resolver_project_ids()

-- Ownership continua sendo um braço separado da conta bruta.
auth_user_accessible_project_ids()                  -- membership canônica ∪ created_by bruto
auth_user_coordinator_or_creator_project_ids()      -- coordenação canônica ∪ created_by bruto
```

As policies de trabalho próprio usam `auth_user_member_identity_ids(project_id)` em `assignments`, `responses`, `reviews`, `field_reviews`, `verdict_acknowledgments`, `response_equivalences` e `researcher_field_orders`. As policies por projeto usam os helpers canônicos; a policy única de `profiles` libera perfis dos membros de projetos acessíveis sem expor equipes de outros projetos. `member_email_links` permanece visível aos membros do projeto (FR-015) e mutável apenas por coordenadores/criador (FR-014).

## Função de unificação

```sql
CREATE FUNCTION unify_project_members(
  p_project_id UUID, p_source_user_id UUID, p_target_user_id UUID,
  p_acting_user_id UUID
) RETURNS void SECURITY DEFINER ...
```

Numa transação, no escopo de `p_project_id` (ver D4 do research.md):

| Tabela | Coluna(s) migrada(s) source→target | Tratamento de colisão |
|--------|-----------------------------------|----------------------|
| `assignments` | `user_id` | `UNIQUE(document_id, user_id, type)`: se o target já tem a mesma (doc, type), deleta a do source |
| `responses` | `respondent_id` | recalcular `is_latest` por documento (a mais recente do conjunto fundido fica `true`) |
| `reviews` | `reviewer_id` | — |
| `verdict_acknowledgments` | `respondent_id` | em colisão de `(review_id, respondent_id)`, a linha do target prevalece |
| `field_reviews` | `self_reviewer_id`, `arbitrator_id` | sem colisão possível — `field_reviews_unique` é `(document_id, field_name)` e não envolve usuário (migration `20260513000001_field_reviews.sql:45`) |
| `response_equivalences` | `reviewer_id` | — |
| `researcher_field_orders` | remove a linha do source | preferência pessoal do target prevalece |
| `project_members` | deleta linha do source | papel/permissões do target prevalecem (spec, edge case de papéis) |
| `member_email_links` | re-aponta `member_user_id` do source para o target e registra source→target | reutiliza alias já voltado ao target; aborta antes das mutações se aponta a outro target ou se o e-mail colide |

Antes de validar e migrar, a função bloqueia as memberships source e target em ordem determinística. Assim, unificações concorrentes sobre identidades sobrepostas se serializam e a segunda chamada revalida o estado já confirmado pela primeira, em vez de produzir alias parcial ou depender do cascade.

Campos de ator e auditoria não são identidade de trabalho e permanecem ligados à conta que realizou o ato: `reviews.resolved_by`, `project_comments.author_id/resolved_by`, os `resolved_by` das três tabelas de resolução e `assignment_batches.created_by` não são reatribuídos pela unificação.

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

`*` = novo nesta feature. Invariante central: **dentro de um projeto, todo dado de trabalho referencia apenas o id canônico do membro**; contas vinculadas nunca aparecem em `assignments`/`responses` — a resolução acontece no contexto de acesso da aplicação e no RLS.
