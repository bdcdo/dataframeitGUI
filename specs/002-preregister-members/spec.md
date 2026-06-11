# Feature Specification: Pré-registro de membros sem conta e vínculo de múltiplos e-mails

**Feature Branch**: `002-preregister-members`

**Created**: 2026-06-11

**Status**: Draft

**Input**: User description: "quero poder adicionar pessoas ainda sem conta no site a um projeto, para que elas entrem normalmente no projeto ao serem adicionadas; incluir também a função de linkar mais de um email ao mesmo pesquisador, por enquanto como algo que o coordenador faz, não o pesquisador"

## Clarifications

### Session 2026-06-11

- Q: Após unificar dois membros, desfazer o vínculo separa os membros de volta? → A: Não — a unificação é permanente; desvincular o e-mail depois apenas impede acessos futuros por aquele e-mail, e atribuições e histórico permanecem no membro unificado.
- Q: Vincular um e-mail que ainda não tem conta funciona como pré-registro daquele e-mail para o mesmo membro? → A: Sim — a pessoa pode criar conta com qualquer um dos e-mails vinculados e entra no projeto como aquele membro.
- Q: Quem vê os e-mails adicionais vinculados de um membro? → A: Todos os membros do projeto veem todos os e-mails vinculados de cada membro, como já ocorre com o e-mail principal na lista de membros.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pré-registrar pessoa sem conta no projeto (Priority: P1)

O coordenador está montando a equipe de um projeto de análise e parte dos pesquisadores ainda não criou conta na plataforma. Ele adiciona cada pessoa pelo e-mail na tela de membros, e a pessoa passa a existir como membro do projeto imediatamente — aparece na lista com status "pendente" e já pode receber atribuições de documentos (pelo sorteio ou manualmente), como qualquer outro membro. Não é enviado e-mail pelo sistema: o coordenador avisa a pessoa por conta própria. Quando a pessoa cria a conta usando aquele e-mail, ela encontra o projeto e suas atribuições prontas no primeiro acesso, sem nenhuma ação adicional do coordenador.

**Why this priority**: É o pedido central da feature. Hoje o coordenador só consegue planejar a distribuição de trabalho depois que toda a equipe se cadastrou, o que trava a preparação do projeto. Com o pré-registro, a montagem da equipe e a distribuição de documentos deixam de depender do ritmo de cadastro de cada pesquisador.

**Independent Test**: Pode ser testado de ponta a ponta adicionando um e-mail inexistente na plataforma a um projeto, atribuindo documentos a esse membro pendente e, em seguida, criando uma conta com aquele e-mail — o novo usuário deve ver o projeto e as atribuições no primeiro acesso.

**Acceptance Scenarios**:

1. **Given** um e-mail que não pertence a nenhuma conta da plataforma, **When** o coordenador o adiciona como membro do projeto, **Then** o membro aparece na lista de membros com status "pendente" e papel escolhido (pesquisador ou coordenador).
2. **Given** um membro pendente no projeto, **When** o coordenador executa o sorteio de atribuições ou atribui documentos manualmente, **Then** o membro pendente é elegível e recebe atribuições como qualquer membro ativo.
3. **Given** um membro pendente com atribuições, **When** a pessoa cria conta na plataforma com o e-mail pré-registrado, **Then** no primeiro acesso ela vê o projeto, suas atribuições e seu papel, sem qualquer intervenção do coordenador, e seu status na lista passa de "pendente" para ativo.
4. **Given** um membro pendente, **When** o coordenador percebe que digitou o e-mail errado, **Then** ele consegue corrigir o e-mail ou remover o membro pendente antes do primeiro acesso.
5. **Given** o mesmo e-mail pré-registrado em mais de um projeto, **When** a pessoa cria conta com aquele e-mail, **Then** ela entra em todos os projetos em que foi pré-registrada.
6. **Given** um e-mail que já pertence a uma conta existente, **When** o coordenador o adiciona como membro, **Then** o comportamento atual se mantém: o usuário existente entra no projeto como membro ativo.

---

### User Story 2 - Vincular mais de um e-mail ao mesmo pesquisador (Priority: P2)

Um pesquisador foi pré-registrado (ou já participa do projeto) com um e-mail, mas criou conta — ou pretende entrar — com outro e-mail (por exemplo, institucional vs. pessoal). O coordenador vincula o segundo e-mail ao membro do projeto. A partir daí, para aquele projeto, é indiferente com qual dos e-mails a pessoa entra na plataforma: ela acessa o projeto como o mesmo membro e vê o mesmo conjunto unificado de atribuições, respostas e progresso. O vínculo é gerido exclusivamente pelo coordenador e vale no escopo do projeto — fora dele, as contas continuam independentes.

**Why this priority**: Complementa a US1 resolvendo seu principal modo de falha — a pessoa se cadastra com um e-mail diferente do pré-registrado e ficaria de fora do projeto (ou duplicada). Depende conceitualmente da noção de membro por e-mail introduzida na US1, por isso vem em seguida.

**Independent Test**: Pode ser testado vinculando um segundo e-mail a um membro existente e acessando o projeto com uma conta desse segundo e-mail — o acesso deve se dar como o mesmo membro, com as mesmas atribuições.

**Acceptance Scenarios**:

1. **Given** um membro do projeto (ativo ou pendente), **When** o coordenador vincula um e-mail adicional a ele, **Then** o e-mail adicional aparece associado ao membro na lista de membros.
2. **Given** um membro com dois e-mails vinculados, **When** a pessoa entra na plataforma com qualquer um dos dois, **Then** ela acessa o projeto como o mesmo membro e vê exatamente o mesmo conjunto de atribuições, respostas e progresso.
3. **Given** um e-mail adicional vinculado que ainda não pertence a nenhuma conta, **When** a pessoa cria conta com esse e-mail, **Then** ela entra no projeto como o membro ao qual o e-mail foi vinculado — o vínculo de e-mail sem conta vale como pré-registro para o mesmo membro — e, se o membro estava pendente, ele passa a ativo nesse primeiro acesso.
4. **Given** um e-mail adicional que já corresponde a outro membro do mesmo projeto, **When** o coordenador solicita o vínculo, **Then** o sistema explica que os dois membros serão unificados naquele projeto (atribuições somadas, sem perda nem duplicação de respostas) e só executa após confirmação explícita do coordenador.
5. **Given** um e-mail já vinculado a um membro do projeto, **When** o coordenador tenta vinculá-lo a outro membro do mesmo projeto, **Then** o sistema impede e informa a qual membro o e-mail já está vinculado.
6. **Given** um membro com e-mail adicional vinculado, **When** o coordenador desfaz o vínculo, **Then** o e-mail deixa de dar acesso ao projeto como aquele membro, mas todo o histórico já produzido (respostas, revisões) permanece intacto e atribuído ao membro.
7. **Given** contas distintas associadas aos e-mails vinculados, **When** qualquer uma delas acessa áreas fora do projeto, **Then** as contas permanecem independentes — o vínculo não mescla perfis, dados pessoais nem participação em outros projetos.

---

### Edge Cases

- Membro pendente que nunca cria conta: permanece "pendente" indefinidamente; o coordenador pode removê-lo a qualquer momento.
- Remoção de membro pendente que já tem atribuições: as atribuições retornam ao conjunto de documentos não atribuídos do projeto (mesmo comportamento da remoção de um membro ativo com trabalho não iniciado).
- E-mail digitado com erro de formato: o sistema rejeita na entrada, com mensagem clara.
- E-mail digitado errado, mas válido: corrigível pelo coordenador enquanto o membro estiver pendente (cenário 4 da US1); depois do primeiro acesso, o caminho é o vínculo de e-mail adicional (US2) ou remoção.
- Pessoa se cadastrou com e-mail diferente do pré-registrado: o coordenador vincula o e-mail real ao membro pendente (US2); ao confirmar, a pessoa passa a acessar o projeto com as atribuições já feitas ao membro pendente.
- Unificação de dois membros que já têm respostas para o mesmo documento: as respostas são preservadas; para fins de contagem de respostas independentes por documento (comparações), passam a contar como de um único pesquisador, e o sistema sinaliza ao coordenador os documentos afetados na confirmação da unificação.
- Diferenciação de papéis na unificação: se os dois membros unificados tinham papéis ou permissões diferentes (por exemplo, um coordenador e um pesquisador), prevalecem o papel e as permissões do membro-alvo do vínculo, informados na confirmação.
- Pré-registro de e-mail já pré-registrado no mesmo projeto: o sistema impede duplicidade e informa que o membro já existe.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O coordenador MUST poder adicionar ao projeto um e-mail que ainda não pertence a nenhuma conta da plataforma, escolhendo o papel (pesquisador ou coordenador), sem que nenhum e-mail seja enviado pelo sistema.
- **FR-002**: O sistema MUST exibir membros pré-registrados na lista de membros com status visível de "pendente" (ainda sem primeiro acesso), distinguindo-os dos membros ativos.
- **FR-003**: Membros pendentes MUST ser elegíveis para atribuição de documentos — tanto pelo sorteio quanto por atribuição manual — em igualdade com membros ativos.
- **FR-004**: Quando uma pessoa cria conta com um e-mail pré-registrado, o sistema MUST conceder-lhe acesso automático a todos os projetos em que aquele e-mail foi pré-registrado, com o papel, as permissões e as atribuições já definidos, sem ação do coordenador.
- **FR-005**: O coordenador MUST poder corrigir o e-mail ou remover um membro pendente; na remoção, as atribuições do membro retornam ao conjunto de documentos não atribuídos. A correção de e-mail vale para todos os projetos em que aquele e-mail está pré-registrado (trata-se da mesma pessoa); quando o pendente pertence a mais de um projeto, o sistema informa isso ao coordenador antes de confirmar.
- **FR-006**: O sistema MUST validar o formato do e-mail na entrada e impedir pré-registro duplicado do mesmo e-mail no mesmo projeto.
- **FR-007**: O coordenador MUST poder vincular um ou mais e-mails adicionais a um membro do projeto (ativo ou pendente); o pesquisador não gerencia os próprios vínculos nesta versão.
- **FR-008**: O sistema MUST garantir que o acesso ao projeto por qualquer e-mail vinculado se dê como o mesmo membro, com conjunto unificado de atribuições, respostas e progresso.
- **FR-009**: Quando o e-mail a vincular corresponde a outro membro do mesmo projeto, o sistema MUST exigir confirmação explícita do coordenador antes de unificar os dois membros, explicando as consequências (atribuições somadas, papel resultante, documentos com respostas de ambos).
- **FR-010**: A unificação de membros MUST preservar todas as respostas e revisões existentes, sem perda nem duplicação, e MUST passar a tratá-las como de um único pesquisador para fins de comparações e contagens por documento.
- **FR-011**: O sistema MUST impedir que um mesmo e-mail fique vinculado a mais de um membro do mesmo projeto, informando o conflito ao coordenador.
- **FR-012**: O coordenador MUST poder desfazer o vínculo de um e-mail adicional; o histórico já produzido permanece atribuído ao membro. A unificação de membros (FR-009) é permanente: o desvínculo posterior do e-mail não separa os membros de volta, apenas impede acessos futuros por aquele e-mail.
- **FR-013**: O vínculo de e-mails MUST ter efeito restrito ao projeto em que foi criado: perfis, dados pessoais e participação em outros projetos das contas envolvidas permanecem independentes.
- **FR-014**: Apenas coordenadores do projeto MUST poder pré-registrar membros, corrigir e-mails pendentes, vincular e desvincular e-mails.
- **FR-015**: Os e-mails vinculados de cada membro MUST ser visíveis a todos os membros do projeto na lista de membros, no mesmo regime de visibilidade do e-mail principal.

### Key Entities

- **Membro pendente**: pessoa adicionada a um projeto por e-mail antes de ter conta; tem papel, permissões e atribuições como um membro comum, mais o e-mail de pré-registro e o estado "sem primeiro acesso". Converte-se em membro ativo no primeiro acesso.
- **Vínculo de e-mail**: associação, no escopo de um projeto, entre um e-mail adicional e um membro; determina que o acesso por aquele e-mail se dá como aquele membro. Criado e removido pelo coordenador.
- **Unificação de membros**: operação que funde dois membros do mesmo projeto numa única identidade de projeto, somando atribuições e preservando respostas; exige confirmação do coordenador e é permanente (não há "des-unificação").

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O coordenador consegue pré-registrar uma pessoa sem conta e atribuir-lhe documentos em menos de 1 minuto, sem sair da área de gestão do projeto.
- **SC-002**: 100% das pessoas que criam conta com um e-mail pré-registrado veem seus projetos e atribuições no primeiro acesso, sem qualquer intervenção do coordenador.
- **SC-003**: Após o vínculo de e-mails, a pessoa acessa o projeto com qualquer um dos e-mails vinculados e vê exatamente o mesmo conjunto de atribuições — zero atribuições perdidas, zero duplicadas.
- **SC-004**: Em toda unificação de membros, 100% das respostas e revisões pré-existentes permanecem acessíveis e corretamente atribuídas após a operação.
- **SC-005**: A lista de membros distingue pendentes de ativos em 100% dos casos, e o status muda para ativo no primeiro acesso da pessoa — inclusive quando o primeiro acesso acontece por um e-mail vinculado, e não pelo e-mail de pré-registro.

## Assumptions

- O pré-registro não expira: um membro pendente permanece válido até a pessoa criar conta ou o coordenador removê-lo.
- Nenhum e-mail transacional (convite, lembrete, notificação) faz parte desta feature; a comunicação com a pessoa convidada acontece fora da plataforma, por decisão explícita do solicitante.
- O vínculo de múltiplos e-mails é gerido exclusivamente pelo coordenador e tem escopo de projeto; autosserviço pelo pesquisador e mesclagem global de contas ficam fora do escopo desta versão.
- A validação de e-mail se limita ao formato; não há verificação de existência ou posse do endereço (coerente com a ausência de envio de e-mail).
- O fluxo atual de adição de membros com conta existente permanece inalterado; esta feature estende o fluxo para e-mails sem conta e adiciona o vínculo de e-mails.
- A plataforma continua sendo de uso desktop, e as novas interações vivem na área de gestão de membros já existente.
