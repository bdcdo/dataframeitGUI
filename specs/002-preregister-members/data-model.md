# Data Model: Pré-registro de membros e vínculo de múltiplos e-mails

**Feature**: `002-preregister-members` | **Data**: 2026-06-11

## Mudanças em tabelas existentes

### `profiles` — nova coluna `activated_at`

```sql
ALTER TABLE profiles ADD COLUMN activated_at TIMESTAMPTZ;
UPDATE profiles SET activated_at = created_at;  -- backfill: existentes contam como ativos
```

- **Semântica**: `NULL` = o profile ainda não concluiu acesso autenticado. A coluna é preenchida uma única vez pela reconciliação compartilhada entre os webhooks `user.created`/`user.updated` e a action idempotente `completeAccess()`. Uma ação administrativa de vínculo não ativa profile algum; quando uma conta-alias ativa acessa o projeto, a lista deriva o status ativo daquele membro a partir do profile canônico **ou** dos profiles vinculados ativos, sem alterar globalmente o `activated_at` da identidade canônica. `getAuthUser()` permanece read-only.
- **Estados**: `claimable (activated_at IS NULL e sem clerk_user_mapping)` → `reclamado (mapping existe, ainda que access_sync_version = 0)` → `ativo (activated_at NOT NULL e snapshot concluído)`. `activated_at` só faz a transição `NULL → timestamp`; a existência do mapping é permanente e torna o UUID indisponível para outra conta ou para correção administrativa do e-mail.
- Sem index novo: a coluna é lida via join `project_members → profiles`, já indexado.

### `clerk_user_mapping` — marker, geração e revogação

O mapping persistente é a âncora local da conta Clerk. `supabase_user_id` referencia `profiles(id) ON DELETE CASCADE`; `access_sync_version` é `0` enquanto os efeitos locais não estão concluídos e `1` quando o snapshot atual terminou; `access_snapshot_version` guarda a geração `user.updatedAt`; `clerk_deleted` torna a exclusão daquele Clerk ID terminal. `clerk_user_id` e `supabase_user_id` são imutáveis, e `clerk_deleted = true` exige marker `0` e não pode voltar a `false`. `clerk_uid()` só devolve o UUID quando `sub`, claim `supabase_uid`, mapping, marker concluído e ausência de revogação concordam.

`claim_clerk_supabase_identity` toma a trava global e só cria mapping para um profile `claimable`; profiles ativos e UUIDs já mapeados falham fechados. A correção administrativa de e-mail usa a mesma trava dentro de um trigger de `auth.users`, revalida o estado `claimable` e atualiza `auth.users.email` e `profiles.email` na mesma transação. Assim, claim e correção não dependem de uma sequência `SELECT → API → UPDATE` concorrente.

A reconciliação é deliberadamente bifásica. `begin_clerk_access_snapshot` toma a trava de identidade, rejeita geração anterior ou mapping revogado e grava marker `0` com a geração escolhida numa transação própria. `complete_clerk_access_snapshot` aceita somente essa geração, atualiza o profile, reconcilia a lista completa de e-mails verificados e grava marker `1` na mesma transação. Falha na segunda fase deixa o marker anterior invalidado; retry repete a conclusão da geração atual. A metadata Clerk é publicada somente depois. `user.deleted` usa duas fases equivalentes de revogação: primeiro marker `0` + `clerk_deleted = true`, depois aliases vazios.

Sem e-mail primário verificado, o snapshot existente é concluído com `p_activate = false` e lista vazia: aliases são revogados e o marker não volta a `1`. Sem mapping, nenhuma identidade é criada. Esses estados falham fechados por contrato.

## Tabela nova

### `member_email_links`

Registro de e-mails adicionais vinculados a um membro, com efeito restrito ao projeto (FR-013). Serve também de alias: `linked_user_id` guarda o profile conhecido para o endereço, mas o acesso como `member_user_id` só existe quando a conta Clerk autenticada concluiu o mapping para esse profile.

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
CREATE INDEX member_email_links_linked_user_project_idx
  ON member_email_links(linked_user_id, project_id)
  WHERE linked_user_id IS NOT NULL;
CREATE INDEX idx_member_email_links_email ON member_email_links(email);                 -- lookup no webhook de signup
```

**Invariantes no schema**:

- Cada conta (`linked_user_id`) resolve para no máximo um membro canônico por projeto; vários e-mails da mesma conta podem manter linhas distintas quando apontam ao mesmo target. O trigger serializado rejeita targets diferentes, e a relação RLS usa `UNION` para devolver a membership uma única vez. A mesma conta pode resolver para membros diferentes em projetos diferentes.
- `member_user_id` deve existir em `project_members` no mesmo projeto. A FK simples anterior para `profiles(id)` é redundante: a FK composta já chega ao profile por `project_members.user_id` e faz cascade quando a membership canônica é removida.
- Self-alias (`linked_user_id = member_user_id`) é inválido.
- A identidade canônica é terminal: um UUID não pode aparecer simultaneamente como `linked_user_id` e `project_members.user_id` no mesmo projeto, nem ocupar os dois lados de vínculos. Triggers de statement em `member_email_links` e `project_members` tomam o mesmo advisory lock global antes de qualquer linha; os triggers de linha tornam cadeias, ciclos e a coexistência alias/membership irrepresentáveis, inclusive sob inserts concorrentes, sem impedir que várias contas apontem para o mesmo membro terminal.

**Validações na server action**:

- Formato de e-mail + normalização lowercase/trim (FR-006).
- `member_user_id` deve ser membro do projeto.
- E-mail igual ao principal de outro membro do projeto → fluxo de unificação com confirmação (FR-009), não insert direto.
- Proibido vincular e-mail já presente em `member_email_links` do projeto (constraint + mensagem amigável, FR-011).
- `profileByEmail` é apenas o profile encontrado pelo texto de e-mail; `ownerProfile` é o profile mapeado pela conta cuja posse atual foi verificada no Clerk. Somente `ownerProfile` produz `access: "ready"`; divergência entre os dois entra no preview ou falha fechada, nunca vira fallback implícito.

**Ciclo de vida**:

1. `linked_user_id IS NULL` — vínculo cujo e-mail ainda não possui profile (vale como pré-registro do e-mail para o mesmo membro, clarificação Q2).
2. `linked_user_id = <profile>` — e-mail já possui profile, ativo ou pendente; quando esse profile conclui a reconciliação autenticada, acessa o projeto como `member_user_id` (RLS + effective member id). Guardar o UUID conhecido desde a criação elimina uma segunda representação do mesmo vínculo e não muda `activated_at`.
3. Linha deletada — desvínculo (FR-012): acessos futuros pelo e-mail cessam; histórico intacto (nada referencia a linha).
4. Linha criada pela unificação (D4) com `linked_user_id = source` — registra que a conta source age como target no projeto; permanente.

Em qualquer estado resolvido, existe exatamente uma identidade de trabalho por conta e projeto. Se houver alias, a conta vinculada não pode ter membership própria; papel, flags e policies de own rows vêm somente da membership canônica. Ownership em `projects.created_by` e autoria/auditoria continuam ligados à conta autenticada quando o respectivo contrato pede o id bruto.

## Funções e policies RLS

As funções RLS resolvem a membership canônica antes de calcular acesso ou papel:

```sql
-- Exatamente uma identidade de trabalho quando existe membership terminal:
-- a própria membership direta ou a membership canônica apontada pelo alias.
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

O helper de identidade não devolve o UUID bruto quando a conta não possui membership direta nem alias válido naquele projeto. Remover a membership revoga também mutações sobre linhas históricas; ownership de projeto continua em helpers separados, ligado a `projects.created_by`.

## Função de unificação

```sql
CREATE FUNCTION unify_project_members(
  p_project_id UUID, p_source_user_id UUID, p_target_user_id UUID,
  p_linked_user_id UUID, p_link_email TEXT,
  p_acting_user_id UUID
) RETURNS void SECURITY DEFINER ...
```

Numa transação, no escopo de `p_project_id` (ver D4 do research.md):

| Tabela                    | Coluna(s) migrada(s) source→target                                          | Tratamento de colisão                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignments`             | `user_id`                                                                   | `UNIQUE(document_id, user_id, type)`: se o target já tem a mesma (doc, type), deleta a do source                                                                                 |
| `responses`               | `respondent_id`                                                             | recalcular `is_latest` por documento (a mais recente do conjunto fundido fica `true`)                                                                                            |
| `reviews`                 | `reviewer_id`                                                               | se source e target já revisaram o mesmo `(document_id, field_name)`, aborta sem apagar nenhuma review                                                                            |
| `verdict_acknowledgments` | `respondent_id`                                                             | em colisão de `(review_id, respondent_id)`, a linha do target prevalece                                                                                                          |
| `field_reviews`           | `self_reviewer_id`, `arbitrator_id`                                         | se source e target ocupam lados opostos da mesma arbitragem ainda aberta, a unificação aborta; histórico com `final_verdict` concluído pode convergir para a identidade canônica |
| `response_equivalences`   | `reviewer_id`                                                               | —                                                                                                                                                                                |
| `researcher_field_orders` | remove a linha do source                                                    | preferência pessoal do target prevalece                                                                                                                                          |
| `project_members`         | deleta linha do source                                                      | papel/permissões do target prevalecem (spec, edge case de papéis)                                                                                                                |
| `member_email_links`      | re-aponta `member_user_id` do source para o target e registra source→target | source e target chegam como memberships terminais; colisão do e-mail principal ao criar o novo alias aborta e reverte a transação                                                |

Antes de validar e migrar, a função toma o advisory lock global de gestão de identidade, bloqueia as memberships source e target em ordem determinística e revalida que ambas ainda existem. Em seguida, bloqueia em `SHARE ROW EXCLUSIVE` as sete tabelas de trabalho que serão lidas ou migradas (`assignments`, `field_reviews`, `researcher_field_orders`, `response_equivalences`, `responses`, `reviews` e `verdict_acknowledgments`), fechando tanto DML já em voo quanto novas escritas até o commit. Assim, unificações concorrentes e criação de aliases/memberships se serializam sem estado parcial; a própria tabela impede `self_reviewer_id = arbitrator_id` enquanto `final_verdict` está pendente, e a RPC atômica de atribuição também exclui o auto-revisor.

Campos de ator e auditoria não são identidade de trabalho e permanecem ligados à conta que realizou o ato: `reviews.resolved_by`, `project_comments.author_id/resolved_by`, os `resolved_by` das três tabelas de resolução e `assignment_batches.created_by` não são reatribuídos pela unificação.

A action chama `preview_project_member_unification`, que devolve somente cinco agregados calculados no banco: atribuições do source, documentos em que ambos têm resposta `is_latest`, colisões de review, conflitos de arbitragem e conflitos de comparação. O diálogo desabilita a confirmação se qualquer conflito for maior que zero; `unify_project_members` chama o mesmo preview novamente sob os locks antes da primeira mutação. A aplicação não baixa conjuntos ilimitados de respostas, reviews ou assignments para remontar essas contagens.

## Invariantes de revisão e comparação preservadas pela unificação

`assignments.status` é `NOT NULL`. Uma comparação ativa é qualquer assignment `type = 'comparacao'` cujo status seja diferente de `concluido`; ela não pode ter como revisor alguém com resposta humana vigente no mesmo documento. Dois triggers bilaterais protegem as duas ordens possíveis — criar/alterar a comparação depois da codificação ou criar/alterar a codificação depois da comparação — e ambas tomam o mesmo advisory lock por `(project_id, document_id)`. A RPC `assign_comparison_if_eligible` usa esse lock antes de revalidar membership e resposta; múltiplos revisores manuais continuam permitidos quando não codificaram o documento.

As fases de `field_reviews` formam uma máquina de estados no banco. O auto-revisor só executa `NULL → self_verdict`; o árbitro só registra a decisão cega depois de `self_verdict = 'contesta_llm'` e a decisão final depois da etapa cega; o coordenador só devolve uma arbitragem aberta ao pool. `self_reviewed_at`, `blind_decided_at` e `final_decided_at` são definidos pelo trigger com `statement_timestamp()`, portanto o cliente não pode antecipar fases nem forjar horários.

Comentários automáticos originados por uma revisão usam `source_field_review_id` único e uma FK composta `(source_field_review_id, project_id, document_id, field_name) → field_reviews(id, project_id, document_id, field_name) ON DELETE CASCADE`. Quando a origem existe, documento e campo são obrigatórios; comentários manuais deixam a origem `NULL`, e usuários autenticados não podem preenchê-la nem alterá-la. A FK torna a proveniência exata irrepresentável fora do projeto, documento ou campo da revisão, e a unicidade garante um único efeito automático por `field_review`.

O fechamento do assignment de arbitragem usa `sync_arbitration_assignment_status`, uma RPC `SECURITY DEFINER` que primeiro autoriza a identidade canônica do chamador e depois segue a mesma ordem membership → advisory lock da atribuição. Ela conclui o assignment somente quando não existe `field_review` ainda pendente para aquele árbitro; uma atribuição concorrente observa o fechamento ou reabre o assignment, sem janela `SELECT → UPDATE` na aplicação.

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
