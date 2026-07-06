# Feature Specification: Caminho de autenticação rápido e recuperável

**Feature Branch**: `003-auth-render-path`

**Created**: 2026-07-06

**Status**: Draft

**Input**: User description: "Melhorar a autenticação após a issue #187: reduzir a latência de páginas autenticadas causada por verificações remotas durante a renderização, manter o caminho oficial Clerk/Supabase como padrão, incluir cache por request na mesma spec, preservar RLS e evitar que pesquisadores fiquem bloqueados quando o vínculo de conta ainda não estiver pronto."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Acessar projeto sem espera perceptível de autenticação (Priority: P1)

O coordenador ou pesquisador já autenticado abre o dashboard ou uma página de projeto e consegue começar a trabalhar sem que a plataforma refaça verificações remotas de identidade durante cada renderização protegida. A experiência esperada é que autenticação e permissão já estejam preparadas quando a página protegida carrega, de modo que o tempo de espera percebido seja dominado pelo carregamento dos dados do projeto, não por uma nova rodada de autenticação.

**Why this priority**: Esta é a motivação central da issue #187. Depois da melhoria de região do PR #185, o custo restante mais visível passou a ser a autenticação no caminho crítico de páginas protegidas.

**Independent Test**: Pode ser testado com uma conta autenticada e com vínculo interno já preparado, acessando uma página de projeto sem cache de navegador e medindo se a página fica utilizável dentro do orçamento definido, sem múltiplas resoluções de identidade na mesma solicitação.

**Acceptance Scenarios**:

1. **Given** um usuário autenticado com vínculo de acesso já preparado, **When** ele abre uma página de projeto protegida, **Then** a página carrega dentro da meta de tempo definida e mostra o conteúdo autorizado sem etapa intermediária de autenticação.
2. **Given** uma mesma renderização protegida que precisa consultar várias informações do projeto, **When** essas informações são carregadas, **Then** a identidade autenticada é reutilizada dentro da própria solicitação em vez de ser recalculada repetidamente.
3. **Given** um usuário autenticado que alterna entre páginas protegidas do mesmo projeto, **When** ele navega para uma página de análise, configuração ou progresso, **Then** a plataforma mantém a mesma experiência de acesso rápido e autorizado.

---

### User Story 2 - Concluir acesso quando o vínculo de conta ainda não está pronto (Priority: P2)

O usuário que acabou de entrar, ou cuja conta ainda não foi vinculada ao perfil interno da plataforma, recebe uma tela clara de conclusão de acesso. A tela explica que a sessão existe, mas que a plataforma ainda está preparando o vínculo necessário para acessar dados protegidos; oferece uma nova tentativa segura e orienta o usuário a procurar suporte apenas quando a recuperação automática não resolver.

**Why this priority**: A melhoria de performance não pode transformar falhas de sincronização em bloqueio silencioso. Pesquisadores e coordenadores precisam entender se devem aguardar, tentar novamente ou pedir suporte.

**Independent Test**: Pode ser testado com uma sessão autenticada sem vínculo interno confirmado, verificando se o usuário é conduzido a um estado recuperável, com mensagem compreensível e sem exposição de ferramentas técnicas.

**Acceptance Scenarios**:

1. **Given** uma sessão autenticada sem vínculo interno confirmado, **When** o usuário conclui o login, **Then** a plataforma mostra um estado de conclusão de acesso com explicação clara e ação de nova tentativa.
2. **Given** uma falha temporária ao preparar o vínculo de acesso, **When** o usuário tenta novamente após a recuperação, **Then** ele é redirecionado para o dashboard sem precisar sair da conta manualmente.
3. **Given** uma conta autenticada que não tem acesso a nenhum projeto, **When** o usuário chega ao dashboard, **Then** a plataforma distingue ausência de projetos de falha técnica de autenticação.

---

### User Story 3 - Preservar permissões, aliases e impersonação (Priority: P3)

O coordenador, pesquisador, pesquisador vinculado por e-mail alternativo ou usuário master em modo de visualização continuam vendo e alterando apenas aquilo que já lhes era permitido. A melhoria de autenticação não muda a regra de negócio de quem pode acessar cada projeto, nem confunde a pessoa autenticada de fato com a identidade efetiva usada para trabalho dentro de um projeto.

**Why this priority**: A plataforma depende de autorização por projeto, papéis, vínculos de e-mail e fluxos de visualização como outro usuário. Qualquer mudança no caminho de autenticação precisa preservar essa separação.

**Independent Test**: Pode ser testado com contas representativas de cada papel acessando os mesmos projetos e ações antes e depois da mudança, confirmando que cada uma vê e altera somente o que já era permitido.

**Acceptance Scenarios**:

1. **Given** um pesquisador atribuído diretamente a um projeto, **When** ele acessa filas e formulários protegidos, **Then** ele vê somente os documentos e ações permitidos para sua identidade efetiva.
2. **Given** um pesquisador que acessa o projeto por vínculo de e-mail alternativo, **When** ele codifica ou revisa documentos, **Then** a plataforma preserva a identidade efetiva do membro canônico sem perder o ator autenticado real.
3. **Given** um usuário master ou coordenador usando visualização como outro usuário, **When** ele navega por páginas protegidas, **Then** a plataforma mantém a distinção entre quem está autenticado e qual identidade está sendo visualizada ou usada para escopo de trabalho.
4. **Given** um usuário autenticado sem permissão para um projeto, **When** ele tenta acessar a URL desse projeto, **Then** o acesso é negado sem revelar dados do projeto.

---

### Edge Cases

- Sessão autenticada existe, mas o vínculo interno ainda não foi criado ou ainda não foi refletido nos dados disponíveis para a sessão.
- Dados de sessão carregam uma identidade interna antiga ou divergente do vínculo persistido.
- Usuário mudou o e-mail principal no provedor de identidade depois de já ter acesso a projetos.
- Vínculo por e-mail alternativo existe para um projeto, mas o usuário também tem acesso direto a outro projeto.
- Usuário master visualiza filas como pesquisador, mas executa ações que precisam registrar o ator real.
- Provedor de identidade ou serviço de sincronização fica temporariamente indisponível durante o login.
- Página protegida faz múltiplas leituras independentes de dados do mesmo projeto durante uma única solicitação.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST reduce repeated authentication work within a single protected page request by reusing the resolved authenticated identity for all reads that belong to that request.
- **FR-002**: The system MUST support authenticated access to dashboards and project pages without requiring a remote identity-provider lookup during the critical rendering path when the user's account link is already prepared.
- **FR-003**: The system MUST use the official supported integration path between the identity provider and the data authorization layer as the default approach for authenticated data access.
- **FR-004**: The system MUST NOT replace per-user authorization controls with a general privileged data-access path for ordinary authenticated pages.
- **FR-005**: The system MUST preserve project-level authorization for coordinators, direct researchers, linked-email researchers, master users, and users without project access.
- **FR-006**: The system MUST preserve the distinction between the authenticated actor, the effective project member identity, and any visualized or impersonated user context.
- **FR-007**: The system MUST provide a user-facing access-completion state when an authenticated account has not yet been linked to an internal profile.
- **FR-008**: The access-completion state MUST explain the situation in non-technical language and offer a recovery action that can be retried safely.
- **FR-009**: The system MUST avoid exposing diagnostic-only links or token-debugging instructions in ordinary user-facing authentication failure states.
- **FR-010**: The system MUST distinguish at least these outcomes: signed out, signed in but link pending, signed in without project access, and signed in with a technical synchronization failure.
- **FR-011**: The system MUST keep account-link preparation idempotent so retrying access completion does not create duplicate user records or duplicate project memberships.
- **FR-012**: The system MUST define a measured contingency process for any non-default token path: it can only be considered after the official supported path fails the performance target in measurement, and it must require explicit security review before implementation.
- **FR-013**: The system MUST provide a regression check that flags reintroduction of the legacy custom-token path or full remote user lookup in protected rendering flows.
- **FR-014**: The system MUST provide observability or test evidence sufficient to show whether authentication work is still contributing materially to protected-page latency.
- **FR-015**: The system MUST keep existing login and sign-out behavior recognizable to current users, except for clearer completion and error states after login.

### Key Entities *(include if feature involves data)*

- **Authenticated Actor**: The real signed-in account controlling the session; used for accountability, master checks, and security decisions that must refer to who is actually logged in.
- **Internal User Profile**: The platform identity used by project membership, ownership, assignments, responses, reviews, and row-level access controls.
- **Account Link**: The durable association between the authenticated actor and the internal user profile, including links created during first login, webhook synchronization, or recovery.
- **Effective Project Member**: The internal identity used for project work when aliases or linked e-mails cause a signed-in account to act as a canonical project member.
- **Project Access Context**: The user's relationship to a project, including creator, coordinator, researcher, master visibility, or no access.
- **Access Completion State**: A temporary state shown after login when the session exists but the platform cannot yet confirm the internal account link required for protected data access.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For an authenticated user with a prepared account link, protected project pages become usable within 300 ms at the 95th percentile under no-browser-cache measurement, with 150–250 ms treated as the target range.
- **SC-002**: In a representative protected page request with multiple independent data reads, authentication identity resolution happens once for the request rather than once per data read.
- **SC-003**: 100% of tested roles — coordinator, direct researcher, linked-email researcher, master user, and authenticated user without access — retain their expected project visibility and permissions after the change.
- **SC-004**: 100% of tested account-link failure cases show a non-technical completion or recovery state instead of a raw error, loop, blank page, or diagnostic-token instruction.
- **SC-005**: No ordinary protected page uses a general privileged data-access path to bypass per-user authorization in the standard authenticated flow.
- **SC-006**: A regression check fails if the legacy custom-token path or full remote user lookup is reintroduced into the protected rendering path.
- **SC-007**: Retrying access completion for the same signed-in account produces at most one internal profile link and does not duplicate project membership records.

## Assumptions

- The existing identity provider remains the login system for this feature; replacing it is out of scope.
- The existing per-user data authorization model remains the security boundary for protected project data; replacing it with application-only authorization is out of scope.
- The first release may include an immediate request-scoped caching slice before the deeper migration, as long as the full feature still targets removal of remote identity work from the critical render path.
- The official supported integration path between the identity provider and the data authorization layer is the default path unless measurement proves it cannot meet the performance target.
- A locally issued database-access token is not part of the default solution; it is a contingency that requires separate security review if measurement justifies it.
- Existing users, project memberships, account links, aliases, and master-user behavior must continue working through the migration.
