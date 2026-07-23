# Contracts: Server Actions e Webhook

**Feature**: `002-preregister-members` | Camada: Next.js Server Actions (`frontend/src/actions/members.ts`) + webhook Clerk (`frontend/src/app/api/webhooks/clerk/route.ts`)

Todas as actions de gestão exigem coordenador do projeto (FR-014). Operações que já partem de uma linha identificada usam o client da sessão e deixam a RLS derivar o projeto e autorizar a mutação; o admin client fica restrito aos fluxos que precisam atravessar identidades, como pré-registro, correção de e-mail, vínculo e unificação, sempre depois de `requireCoordinator`.

## `addMember(projectId, email, role)` — modificada

- Primeiro consulta o dono atual verificado no Clerk. Se existe, reconcilia a conta e usa o `ownerProfile` mapeado, depois rejeita membership direta ou alias já existente naquele projeto.
- Sem dono Clerk confirmado, um `profileByEmail` pendente pode ser reutilizado como placeholder; um profile ativo não concede acesso por coincidência de endereço e produz erro fechado.
- Sem `profileByEmail`, cria placeholder Supabase-only (`auth.users` + `profiles` com `activated_at = NULL`), sem Clerk; insere `project_members`.
- Retorno: `{ pending?: boolean; error?: string }` — `pending: true` quando reutilizou/criou placeholder; conta dona confirmada entra ativa.
- Erros: e-mail inválido (FR-006); já membro (`23505`); não coordenador.

## `updatePendingMemberEmail(projectId, memberUserId, newEmail)` — nova

- Pré-condições: membro do projeto com `profiles.activated_at IS NULL` e sem linha em `clerk_user_mapping`; `newEmail` válido e sem profile/vínculo existente no projeto. `activated_at = NULL` sozinho não torna um UUID editável: um mapping com marker `0` já reservou a identidade para uma conta Clerk.
- Efeito: chama a Auth Admin API para atualizar `auth.users.email`. O trigger `sync_claimable_preregistered_email` toma a mesma trava global de `claim_clerk_supabase_identity`, revalida que o placeholder continua sem mapping e atualiza `profiles.email` na mesma transação de `auth.users`; a action não executa uma segunda escrita de profile. **Efeito global** (FR-005): a correção vale para todos os projetos em que o placeholder está pré-registrado; a action retorna `otherProjectsCount` (projetos além do atual) para a UI exibir aviso de confirmação quando `> 0`.
- Erros: membro já ativo ou já reclamado por uma conta Clerk (corrigir via vínculo/US2); e-mail em uso; falha transacional da Auth Admin API.

## `removeMember(memberId)` — modificada

- A RPC transacional `remove_project_member(memberId)` deriva `project_id` e `user_id` da única linha que a RLS permite remover e deleta, na mesma transação, as `assignments` com `status = 'pendente'`. A remoção da membership aciona o cascade da FK composta sobre `member_email_links`; não há segundo caminho de limpeza na RPC nem na action.

## `linkMemberEmail(projectId, memberUserId, email)` — nova

Casos, na ordem de verificação:

1. A action normaliza o endereço e consulta o Clerk. `profileByEmail` é o resultado administrativo de `profiles.email`; `ownerProfile` só é preenchido a partir do UUID devolvido pela reconciliação da conta que atualmente comprova aquele endereço no Clerk. Os dois valores não são intercambiáveis nem servem de fallback um para o outro.
2. E-mail já vinculado a outro membro do projeto → erro informando a qual membro está vinculado (FR-011). Um vínculo do mesmo membro pode ser atualizado de forma condicional se a posse atual mudou; concorrência que altere a linha entre leitura e update retorna erro de retry.
3. `profileByEmail` ou `ownerProfile` corresponde a outro membro do projeto → **não executa**; retorna `{ status: "requires-unification", preview: { sourceUserId, sourceName, targetUserId, assignmentsToMigrate, docsWithBothResponses, reviewConflicts, arbitrationConflicts, comparisonConflicts, resultingRole, linkEmail } }` para o diálogo de confirmação (FR-009). Mais de uma identidade candidata falha fechada. Qualquer uma das três contagens de conflito bloqueia a confirmação.
4. Existe `ownerProfile`, mas ele não é membro do projeto → insere ou atualiza o link com `linked_user_id` confirmado e retorna `access: "ready"`. Se existe apenas um `profileByEmail` pendente, pode registrar esse UUID sem ativá-lo e retorna `access: "pending"`. Um profile ativo cuja posse atual não foi confirmada nunca concede acesso.
5. E-mail ainda não possui `profile` → insere link com `linked_user_id = NULL`, aguardando a criação da conta. Vincular o e-mail por ação do coordenador não conta como primeiro acesso.

- Retorno discriminado: `{ status: "linked", link, access: "ready" | "pending" }`, `{ status: "requires-unification", preview }` ou `{ status: "error", error }`. Os estados incompatíveis não podem ser construídos simultaneamente.

## `unifyMembers(projectId, sourceUserId, targetUserId, linkEmail)` — nova

- Chamada apenas após confirmação explícita no dialog (FR-009). `linkEmail` vem do preview produzido por `linkMemberEmail`; a action normaliza e revalida a posse ou o placeholder pendente antes de executar, em vez de confiar apenas nos UUIDs do diálogo.
- Efeito: RPC `unify_project_members` (transacional; ver data-model.md). Permanente (clarificação Q1).
- Retorno: `{ error?: string }`; revalida paths de membros, atribuições e comparações.

## `unlinkMemberEmail(projectId, linkId)` — nova

- Deleta a linha; acessos futuros pelo e-mail cessam, histórico permanece (FR-012). Não desfaz unificação.

## Reconciliação de acesso Clerk↔Supabase — modificada

`reconcileClerkUserAccess` é a sequência única chamada pelos webhooks `user.created` e `user.updated`, por `completeAccess()` e pelas actions administrativas que precisam confirmar o dono atual. O e-mail primário precisa estar verificado e é localizado pelo ID primário do Clerk, sem depender da ordem do array; todos os e-mails verificados participam da resolução de aliases. O estado relido do Clerk é a autoridade, não o payload de webhook nem `profiles.email`.

Antes do snapshot, `claim_clerk_supabase_identity` resolve a identidade uma única vez sob a trava global: reutiliza o mapping do mesmo Clerk ID, reclama somente um profile com `activated_at IS NULL` e sem mapping, ou devolve `NULL` para que o placeholder seja criado. As chaves Clerk↔Supabase são imutáveis; profile ativo, placeholder já mapeado e mapping terminalmente excluído nunca são reatribuídos por coincidência de e-mail.

1. `begin_clerk_access_snapshot` grava `access_sync_version = 0` e escolhe `access_snapshot_version = user.updatedAt` numa transação própria. Geração antiga ou mapping com `clerk_deleted = true` retorna superseded sem efeitos posteriores.
2. `complete_clerk_access_snapshot` aceita somente a geração escolhida e, numa segunda transação atômica, ativa/atualiza o profile, faz a lista completa de aliases convergir e grava `access_sync_version = 1`.
3. Somente depois a rotina grava `publicMetadata.supabase_uid`; se o evento já observa o UUID correto, omite a escrita. Se a primeira tentativa foi superada, relê o Clerk uma vez e conclui apenas a geração atual.

Sem primário verificado, um mapping existente passa pela mesma geração com `p_activate = false` e aliases vazios, mantendo o marker fechado; sem mapping, nada é criado. O webhook `user.deleted`, assim como um 404 ao reler a conta, chama `revokeClerkUserAccess`: a primeira fase grava marker `0` e `clerk_deleted = true`, e a segunda remove aliases. Qualquer falha técnica faz o webhook responder `500`; `completeAccess()` devolve estado recuperável. `getAuthUser()` permanece read-only e exige metadata e mapping presentes, coerentes e com `access_sync_version >= 1`.

## Contexto de acesso canônico — `lib/auth.ts`

`getProjectAccessContext(projectId, user): Promise<ProjectAccessContext>` é a porta pública única de páginas e layouts para identidade, projeto e papel. O estado `resolved` contém `accountUserId`, `memberUserId`, projeto, papel da membership canônica, `isMaster` e `isCoordinator`; o estado `unavailable` interrompe a rota ou a mutation, enquanto o estágio técnico exato permanece nos logs do servidor.

Se existir `member_email_links.linked_user_id = user.id` no projeto, `memberUserId` é exclusivamente o `member_user_id` vinculado; caso contrário, é `user.id`. Papel e permissões vêm dessa identidade canônica, enquanto ownership (`projects.created_by`) e autoria/auditoria continuam comparando `accountUserId` quando o contrato da operação exige a conta autenticada.

`resolveProjectMemberActor(projectId)` é a porta única das mutations pessoais: devolve `{ ok: true, user, memberUserId }` ou uma falha discriminada `unauthenticated | identity_unavailable`, preservando a diferença entre logout e falha técnica sem expor um UUID solto. `resolveProjectQueueIdentity(context, viewAsUser)` trata somente a fila visualizada por master e nunca substitui o ator que assina a mutation.
