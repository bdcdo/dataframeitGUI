# Contracts: Server Actions e Webhook

**Feature**: `002-preregister-members` | Camada: Next.js Server Actions (`frontend/src/actions/members.ts`) + webhook Clerk (`frontend/src/app/api/webhooks/clerk/route.ts`)

Todas as actions exigem chamador coordenador do projeto (FR-014), validado como no `addMember` atual; mutações usam admin client.

## `addMember(projectId, email, role)` — modificada

- E-mail com profile existente: comportamento atual (insere `project_members`).
- E-mail sem profile: cria placeholder Supabase-only (`auth.users` + `profiles` com `activated_at = NULL`), **sem** Clerk; insere `project_members`.
- Retorno: `{ pending?: boolean; error?: string }` — `pending: true` quando criou placeholder (substitui o atual `invited`; UI mostra "Membro pré-registrado" em vez de "Convite enviado").
- Erros: e-mail inválido (FR-006); já membro (`23505`); não coordenador.

## `updatePendingMemberEmail(projectId, memberUserId, newEmail)` — nova

- Pré-condições: membro do projeto com `profiles.activated_at IS NULL`; `newEmail` válido e sem profile/vínculo existente no projeto.
- Efeito: atualiza `auth.users.email` (admin API) + `profiles.email`.
- Erros: membro já ativo (corrigir via vínculo/US2); e-mail em uso.

## `removeMember(projectId, memberId)` — modificada

- Além de deletar `project_members`: deleta `assignments` com `status = 'pendente'` do usuário no projeto (FR-005) e os `member_email_links` cujo `member_user_id` é o removido.

## `linkMemberEmail(projectId, memberUserId, email)` — nova

Casos, na ordem de verificação:

1. E-mail já em `member_email_links` do projeto → erro informando a qual membro está vinculado (FR-011).
2. E-mail é o principal de outro membro do projeto → **não executa**; retorna `{ requiresUnification: { sourceUserId, sourceName, targetUserId, assignmentsToMigrate, docsWithBothResponses, resultingRole } }` para o dialog de confirmação (FR-009).
3. E-mail pertence a conta existente não-membro → insere link com `linked_user_id` preenchido.
4. E-mail sem conta → insere link com `linked_user_id = NULL` (vale como pré-registro do e-mail, clarificação Q2).

- Retorno: `{ link?: MemberEmailLink; requiresUnification?: …; error?: string }`.

## `unifyMembers(projectId, sourceUserId, targetUserId)` — nova

- Chamada apenas após confirmação explícita no dialog (FR-009).
- Efeito: RPC `unify_project_members` (transacional; ver data-model.md). Permanente (clarificação Q1).
- Retorno: `{ error?: string }`; revalida paths de membros, atribuições e comparações.

## `unlinkMemberEmail(projectId, linkId)` — nova

- Deleta a linha; acessos futuros pelo e-mail cessam, histórico permanece (FR-012). Não desfaz unificação.

## Webhook Clerk `user.created` — modificado

Após o `syncClerkUserToSupabase` atual (que já mapeia signup para placeholder quando o e-mail coincide — auto-join do FR-004):

1. Marca `profiles.activated_at = now()` no profile resolvido, se `NULL` (transição pendente→ativo, SC-005).
2. Resolve vínculos pendentes: `UPDATE member_email_links SET linked_user_id = <profile> WHERE email = <email> AND linked_user_id IS NULL`.

Fallback em `getAuthUser()` (`frontend/src/lib/auth.ts`): se o profile da sessão tem `activated_at IS NULL`, seta `now()` (cobre webhook perdido e contas antigas).

## Resolução de identidade efetiva — `lib/auth.ts`

`getEffectiveMemberId(projectId: string): Promise<string>` — retorna `member_user_id` se existir alias (`member_email_links.linked_user_id = user.id` no projeto), senão `user.id`. Substitui `user.id` nos pontos de trabalho por projeto: página de coding, my-progress, `actions/responses.ts` (`respondent_id`), `actions/field-reviews.ts` (self/arbitrator). Compõe com o padrão `viewAsUser` (master) já existente.
