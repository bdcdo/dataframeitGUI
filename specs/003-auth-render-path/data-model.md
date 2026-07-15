# Data Model — Caminho de autenticação rápido e recuperável

## Authenticated Actor

A conta real autenticada no provedor de identidade.

**Fields**

- `clerkUserId`: identificador da conta no Clerk.
- `primaryEmail`: e-mail principal observado na sessão.
- `firstName`, `lastName`: nomes exibíveis quando disponíveis.
- `isSignedIn`: indica se há sessão válida.
- `isMaster`: indica se o ator real tem privilégio master registrado em `master_users`.

**Relationships**

- Pode ter exatamente um vínculo ativo com um `Internal User Profile` por meio de `Account Link`.
- Pode visualizar outro usuário em contexto master, mas continua sendo o ator real para auditoria e permissões próprias de escrita.

**Validation rules**

- Sem `clerkUserId`, o estado é signed out e deve redirecionar para login.
- Sem e-mail observável, a conta não pode concluir vínculo automaticamente e deve cair em falha técnica recuperável.

## Internal User Profile

A identidade interna usada por projetos, membros, atribuições, respostas, revisões e RLS.

**Fields**

- `id`: UUID do usuário Supabase usado por `profiles`, `project_members` e políticas RLS.
- `email`: e-mail canônico do perfil.
- `firstName`, `lastName`: nomes exibíveis salvos em `profiles`.
- `activatedAt`: marca se o perfil pré-registrado já foi ativado por login real.

**Relationships**

- Recebe um `Account Link` quando uma conta Clerk é associada ao perfil.
- Pode ser membro direto de projetos em `project_members`.
- Pode ser membro canônico de um usuário que entrou por e-mail alternativo em `member_email_links`.

**Validation rules**

- `id` é a identidade que deve aparecer no JWT Supabase como claim consumida por RLS.
- `activatedAt = null` indica vínculo preparado, mas ainda pendente de ativação real.

## Account Link

Associação durável entre `Authenticated Actor` e `Internal User Profile`.

**Fields**

- `clerkUserId`: origem da conta autenticada.
- `supabaseUserId`: destino interno usado por Supabase/RLS.
- `linkStatus`: `prepared`, `active`, `pending-repair`, `divergent` ou `failed`.
- `lastCheckedAt`: instante da última verificação ou reparo.
- `failureReason`: categoria interna para suporte, sem expor detalhe técnico ao usuário final.

**Relationships**

- Liga exatamente um ator Clerk a um perfil interno ativo para o caminho ordinário.
- Pode apontar para perfil pré-registrado que será ativado no primeiro login.

**Validation rules**

- Retry de criação/reparo deve ser idempotente para o par `(clerkUserId, supabaseUserId)` e para o e-mail canônico observado.
- Se o vínculo estiver ausente ou divergente em página protegida, o render deve falhar fechado e redirecionar para `Access Completion State`.

**State transitions**

- `prepared` → `active`: login real confirma o vínculo e ativa o perfil.
- `prepared` → `pending-repair`: sessão existe, mas a claim ou mapping ainda não reflete o perfil esperado.
- `active` → `divergent`: mapping e metadata/claim apontam para identidades incompatíveis.
- `pending-repair` → `active`: reparo idempotente confirma mapping e metadata.
- qualquer estado → `failed`: falha técnica persistente; usuário recebe mensagem recuperável e suporte recebe diagnóstico.

## Effective Project Member

Identidade interna usada para escopo de trabalho em um projeto específico.

**Fields**

- `projectId`: projeto em avaliação.
- `memberUserId`: usuário canônico do projeto.
- `linkedUserId`: usuário autenticado que acessa via e-mail alternativo, quando aplicável.
- `source`: `direct-member`, `linked-email` ou `self`.

**Relationships**

- Deriva de `project_members` e, quando aplicável, de `member_email_links`.
- É exposto como `memberUserId` por `getProjectAccessContext(projectId, user)`.
- É projetado para a fila por `resolveProjectQueueIdentity(access, viewAsUser)`, que aplica `viewAs` somente para master.

**Validation rules**

- Em filas pessoais, aliases devem resolver para o membro canônico.
- A identidade efetiva não substitui o ator real para decisões de escrita proibidas pela spec.

## Project Access Context

Resultado consolidado da autorização do usuário em um projeto.

**Fields**

- `status`: `resolved` quando identidade, projeto e membership foram lidos sem erro; `unavailable` quando qualquer leitura necessária falhou tecnicamente.
- `accountUserId`: identidade da conta autenticada; preservada para ownership e auditoria.
- `memberUserId`: identidade canônica do membro no projeto; usada para membership e filas de trabalho.
- `project`: projeto encontrado dentro da RLS, ou `null` quando não há visibilidade autorizada.
- `membershipRole`: papel em `project_members`, quando existe.
- `isCoordinator`: true para master, criador do projeto ou membro coordenador.
- `isMaster`: privilégio confirmado do ator real.

**Relationships**

- Usa o `accountUserId` para o ator real e resolve `memberUserId` por projeto antes de consultar o papel.
- É request-scoped por `getProjectAccessContext(projectId, user)`.

**Validation rules**

- Falha de query não pode ser convertida silenciosamente em “sem acesso”.
- Todo consumidor deve chamar `requireResolvedProjectAccess` antes de ler `isCoordinator`; `unavailable` sempre falha fechado.
- Usuário sem permissão recebe negação fechada sem dados do projeto.
- Usuário sem projetos deve receber estado distinto de falha técnica.

## Access Completion State

Estado transitório mostrado quando há sessão, mas a plataforma ainda não consegue confirmar o vínculo interno necessário para acessar páginas protegidas.

**Fields**

- `actorEmail`: e-mail mostrado ao usuário para reconhecimento da conta.
- `reason`: `link-pending`, `link-divergent`, `sync-temporary-failure`, `no-project-access` ou `unknown-recoverable`.
- `retryAvailable`: indica se o usuário pode tentar novamente sem suporte.
- `supportHint`: orientação curta e não técnica quando retry não resolve.
- `nextUrl`: destino protegido pretendido após sucesso.

**Relationships**

- Deriva de `Authenticated Actor` + `Account Link`.
- Encaminha para dashboard ou página protegida original quando o vínculo passa a `active`.

**Validation rules**

- Mensagens são em pt-BR e não expõem tokens, claims, debug links ou instruções internas.
- A ação de retry é segura para repetição e não cria registros duplicados.
- O estado deve ser navegável por teclado, com foco visível e labels acessíveis.
