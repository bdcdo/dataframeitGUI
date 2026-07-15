# Contracts: Server Actions e Webhook

**Feature**: `002-preregister-members` | Camada: Next.js Server Actions (`frontend/src/actions/members.ts`) + webhook Clerk (`frontend/src/app/api/webhooks/clerk/route.ts`)

Todas as actions de gestão exigem coordenador do projeto (FR-014). Operações que já partem de uma linha identificada usam o client da sessão e deixam a RLS derivar o projeto e autorizar a mutação; o admin client fica restrito aos fluxos que precisam atravessar identidades, como pré-registro, correção de e-mail, vínculo e unificação, sempre depois de `requireCoordinator`.

## `addMember(projectId, email, role)` — modificada

- E-mail com profile existente: comportamento atual (insere `project_members`).
- E-mail sem profile: cria placeholder Supabase-only (`auth.users` + `profiles` com `activated_at = NULL`), **sem** Clerk; insere `project_members`.
- Retorno: `{ pending?: boolean; error?: string }` — `pending: true` quando criou placeholder (substitui o atual `invited`; UI mostra "Membro pré-registrado" em vez de "Convite enviado").
- Erros: e-mail inválido (FR-006); já membro (`23505`); não coordenador.

## `updatePendingMemberEmail(projectId, memberUserId, newEmail)` — nova

- Pré-condições: membro do projeto com `profiles.activated_at IS NULL`; `newEmail` válido e sem profile/vínculo existente no projeto.
- Efeito: atualiza `auth.users.email` (admin API) + `profiles.email`. **Efeito global** (FR-005): a correção vale para todos os projetos em que o placeholder está pré-registrado; a action retorna `otherProjectsCount` (projetos além do atual) para a UI exibir aviso de confirmação quando `> 0`.
- Erros: membro já ativo (corrigir via vínculo/US2); e-mail em uso.

## `removeMember(memberId)` — modificada

- A RPC transacional `remove_project_member(memberId)` deriva `project_id` e `user_id` da única linha que a RLS permite remover; na mesma transação, deleta `assignments` com `status = 'pendente'` e encerra os `member_email_links` cujo `member_user_id` é o removido. A FK composta também garante o cascade dos aliases, sem depender de limpeza posterior na action.

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
3. Ativa os membros canônicos desses vínculos: `UPDATE profiles SET activated_at = now() WHERE id IN (<member_user_id resolvidos no passo 2>) AND activated_at IS NULL` — sem isso, um pendente cuja pessoa entra pelo e-mail vinculado ficaria "pendente" para sempre (SC-005, caminho via alias).

`getAuthUser()` (`frontend/src/lib/auth.ts`) é read-only e não ativa profiles. O webhook executa a transição normal; se o vínculo continuar incompleto, a tela de conclusão chama a action idempotente `completeAccess()`, que sincroniza o vínculo e ativa o profile fora do caminho de autenticação e renderização.

## Contexto de acesso canônico — `lib/auth.ts`

`getProjectAccessContext(projectId, user): Promise<ProjectAccessContext>` é a porta pública única de páginas e layouts para identidade, projeto e papel. O estado `resolved` contém `accountUserId`, `memberUserId`, projeto, papel da membership canônica, `isMaster` e `isCoordinator`; o estado `unavailable` interrompe a rota ou a mutation, enquanto o estágio técnico exato permanece nos logs do servidor.

Se existir `member_email_links.linked_user_id = user.id` no projeto, `memberUserId` é exclusivamente o `member_user_id` vinculado; caso contrário, é `user.id`. Papel e permissões vêm dessa identidade canônica, enquanto ownership (`projects.created_by`) e autoria/auditoria continuam comparando `accountUserId` quando o contrato da operação exige a conta autenticada.

`getEffectiveMemberId(projectId)` permanece apenas como projeção temporária para actions pessoais que ainda precisam de um único id de trabalho; falha de resolução lança erro técnico. `resolveProjectQueueIdentity(context, viewAsUser)` aplica a impersonação global somente para master e mantém separadas a fila própria canônica e a conta que assina a operação.
