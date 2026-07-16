# Data Model — Caminho de autenticação rápido e recuperável

## Authenticated Actor

A conta real autenticada no Clerk. O estado atual relido do provedor é a autoridade para identidade de e-mail; payloads antigos de webhook, metadata e coincidências em `profiles.email` não provam posse por si.

**Fields observed at runtime**

- `clerkUserId`: identificador da conta no Clerk.
- `primaryEmailAddressId`: ID do endereço primário escolhido no Clerk.
- `verifiedPrimaryEmail`: e-mail normalizado correspondente ao ID primário, somente quando sua verificação está `verified`.
- `verifiedEmails`: conjunto normalizado de todos os endereços verificados da conta; serve para reconciliar aliases.
- `firstName`, `lastName`: nomes atuais do Clerk, inclusive `null` quando removidos.
- `publicMetadata.supabase_uid`: UUID publicado por último para alimentar o JWT/RLS; não é autoridade isolada.

**Validation rules**

- Sem conta Clerk, o resultado é `signed-out`.
- Sem `primaryEmailAddressId`, com primário não verificado ou com ID que não aparece na lista, a resolução falha fechada; nenhum endereço secundário ocupa silenciosamente o lugar do primário.
- A reconciliação sem primário verificado revoga aliases de mapping existente e não cria identidade quando o mapping ainda não existe.
- `user.deleted`, ou uma releitura que retorna 404, inicia revogação terminal daquele `clerkUserId`.

## Internal User Profile

A identidade Supabase usada por projetos, memberships, atribuições, respostas, revisões e RLS.

**Persisted fields relevant to this feature**

- `id`: UUID referenciado por `clerk_user_mapping.supabase_user_id`, `project_members.user_id` e dados de trabalho.
- `email`: e-mail administrativo/canônico do profile; não prova a posse Clerk atual.
- `first_name`, `last_name`: nomes sincronizados na conclusão do snapshot atual.
- `activated_at`: `null` enquanto o profile ainda não concluiu acesso autenticado; preenchido uma única vez quando uma conta válida é ativada. Um valor `null` não basta para autorizar reutilização: a presença de `clerk_user_mapping`, inclusive com marker `0`, significa que a identidade já foi reclamada.

**Relationships and rules**

- Um profile pode ser membership direta em `project_members` ou conta-alias em `member_email_links.linked_user_id`, mas não pode ocupar os dois papéis no mesmo projeto.
- `clerk_user_mapping.supabase_user_id` referencia `profiles(id) ON DELETE CASCADE`; mapping órfão é irrepresentável no schema final.
- As chaves do mapping são imutáveis; `clerk_deleted = true` é terminal e só pode coexistir com marker `0`. `claim_clerk_supabase_identity` só cria mapping para profile sem ativação e sem dono anterior.
- Na lista de um projeto, o membro é ativo quando o profile canônico ou ao menos um profile vinculado naquele projeto tem `activated_at` preenchido. Isso não ativa globalmente o profile canônico.

## Account Link — `clerk_user_mapping`

Associação durável entre a conta Clerk e o profile Supabase. O estado não usa colunas lógicas inventadas; ele é representado pelos campos persistidos abaixo e pela concordância com a metadata.

**Persisted fields**

- `clerk_user_id`: origem Clerk.
- `supabase_user_id`: profile interno, com FK para `profiles(id) ON DELETE CASCADE`.
- `access_sync_version`: marker de conclusão; `0` fecha o acesso durante criação, reparo, snapshot incompleto ou revogação, e valor `>= 1` indica efeitos locais concluídos.
- `access_snapshot_version`: geração monotônica observada em `User.updatedAt`.
- `clerk_deleted`: `true` torna a remoção daquele Clerk ID terminal e impede conclusão posterior de snapshot antigo.

**Derived states**

- `absent`: não há mapping; uma sessão válida segue para conclusão de acesso.
- `pending`: mapping existe com `access_sync_version = 0`; metadata não basta para autenticar.
- `active`: mapping não revogado, marker concluído e `publicMetadata.supabase_uid` igual a `supabase_user_id`.
- `divergent`: marker está concluído, mas metadata e mapping apontam para UUIDs diferentes; é um estado derivado da leitura, não uma coluna persistida.
- `revoked`: `clerk_deleted = true` e marker `0`; aliases derivados foram ou serão removidos idempotentemente.

`clerk_uid()` repete essa validação no banco: exige que o `sub` do JWT encontre o mapping, que o claim `supabase_uid` concorde com `supabase_user_id` e que `access_sync_version >= 1`. Um token antigo não preserva acesso depois que o marker volta a `0`.

## Clerk Access Snapshot

A reconciliação usa duas transações para que falhas parciais fechem acesso em vez de conservar o snapshot anterior.

1. `begin_clerk_access_snapshot(clerkUserId, supabaseUserId, snapshotVersion)` toma a trava global de identidade, rejeita mapping inexistente, revogado ou geração mais antiga, grava `access_sync_version = 0` e escolhe `access_snapshot_version = snapshotVersion`.
2. `complete_clerk_access_snapshot(...)` toma a mesma trava e só aceita a geração ainda escolhida. Profile, nomes, `activated_at`, lista completa de aliases verificados e marker `1` são aplicados atomicamente.
3. `publicMetadata.supabase_uid` é publicado somente depois da segunda fase. Se já contém o mesmo UUID, a escrita é omitida para encerrar o ciclo de `user.updated`.

Se a primeira fase retorna `false`, `reconcileClerkUserAccess()` relê o Clerk uma vez e tenta somente a geração atual. Se a segunda fase falha, o marker `0` da primeira transação permanece commitado e o retry pode repetir a conclusão. Sem primário verificado, a segunda fase recebe aliases vazios e `p_activate = false`, portanto remove acesso derivado e não volta o marker a `1`.

`user.deleted` usa protocolo equivalente: `begin_clerk_user_revocation` grava marker `0` e `clerk_deleted = true`; `complete_clerk_user_revocation` reconcilia aliases com lista vazia. Um 404 durante releitura percorre o mesmo caminho.

## Administrative Email Identity

Actions de membros distinguem duas projeções que podem coexistir e apontar para UUIDs diferentes:

- `profileByEmail`: profile encontrado por `profiles.email`; representa pré-registro ou dado administrativo e nunca prova posse atual.
- `ownerProfile`: profile cujo UUID vem da conta localizada por endereço verificado no Clerk e concluída por `reconcileClerkUserAccess()`; somente ele torna o resultado de vínculo `access: "ready"`.

Quando as projeções divergem, elas são candidatas separadas para preview/unificação ou produzem erro fechado; a action não escolhe uma por conveniência. A reconciliação pode alterar aliases, portanto o contexto administrativo é relido antes da decisão final.

## Effective Project Member

Identidade interna usada para escopo de trabalho em um projeto específico.

**Derived fields**

- `projectId`: projeto solicitado.
- `accountUserId`: UUID da conta Supabase autenticada.
- `memberUserId`: `member_email_links.member_user_id` quando existe alias terminal para `accountUserId`; caso contrário, o próprio `accountUserId`.

**Validation rules**

- Uma conta pode ter várias linhas de e-mail no mesmo projeto, mas todas precisam apontar para o mesmo membro canônico.
- Se a consulta de alias falha ou rejeita, o resultado é `unavailable`; não há fallback para a identidade bruta.
- Membership, papel, flags e dados de trabalho vêm exclusivamente do `memberUserId`; ownership e auditoria continuam usando `accountUserId` quando o contrato pede o ator real.
- Mutations pessoais usam `resolveProjectMemberActor(projectId)`, que devolve `{ ok: true, user, memberUserId }` ou uma falha discriminada; nenhum helper paralelo devolve apenas um UUID e perde o estado de autenticação.

## Project Access Context

`getProjectAccessContext(projectId, user)` retorna uma união discriminada e request-scoped.

**Resolved fields**

- `status: "resolved"`.
- `accountUserId`, `memberUserId`.
- `project`: projeto visível pela RLS, ou `null` quando não há acesso.
- `membershipRole`: papel da membership canônica, ou `null`.
- `isMaster`: privilégio confirmado da conta real.
- `isCoordinator`: `true` para master, criador do projeto ou membership canônica coordenadora.

**Unavailable state**

- `status: "unavailable"` não carrega autorização parcial. Consumidores chamam `requireResolvedProjectAccess()` ou tratam explicitamente o discriminante antes de usar projeto/papel.

Usuário autenticado sem memberships é um estado ordinário do dashboard, não um motivo da tela de conclusão de acesso. Indisponibilidade técnica de identidade, alias, projeto, membership ou `master_users` falha fechada.

## Access Completion State

Estado transitório da rota `frontend/src/app/auth/post-login/page.tsx`, mostrado quando há conta Clerk, mas a resolução read-only ainda não produz `AuthUser`.

**Reasons actually rendered**

- `link-pending`: metadata, mapping ou marker concluído ainda está ausente.
- `link-divergent`: metadata e mapping concluído apontam para identidades incompatíveis.
- `sync-temporary-failure`: não há primário verificado ou alguma leitura técnica falhou.
- `unknown-recoverable`: a action de retry capturou falha não classificada e devolveu orientação genérica.

`actorEmail` é opcional porque falhas podem ocorrer antes de obter um primário verificado. `nextUrl` passa por `safeNextPath()` antes de chegar ao componente. A action `completeAccess()` relê a conta Clerk por ID e chama a reconciliação idempotente; sucesso redireciona ao destino interno seguro, e falha permanece na tela sem expor token, claim, UUID ou nome de tabela.

`no-project-access` não pertence a este union: uma conta autenticada e ativa sem projeto vê o estado vazio do dashboard.
