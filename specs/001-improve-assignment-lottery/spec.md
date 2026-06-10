# Feature Specification: Melhorar o sorteio de atribuições

**Feature Branch**: `001-improve-assignment-lottery`

**Created**: 2026-06-10

**Status**: Draft

**Input**: User description: "quero melhorar a funcionalidade de sortear atribuições. Acho incompleta e pouco funcional. Deveríamos poder selecionar só documentos sem revisão, com no máximo uma revisão, etc. Acho que podemos remover a questão do prazo, porque o controle de prazo por enquanto pode ficar de fora da plataforma."

## Visão geral

O sorteio de atribuições distribui documentos do projeto entre os participantes para codificação ou comparação. Hoje o coordenador não controla quais documentos entram no sorteio (todo documento ativo com vaga participa), cada sorteio descarta as atribuições pendentes do tipo e redistribui tudo — o que inviabiliza lotes incrementais —, o conjunto de participantes é rígido (todos os pesquisadores, sempre) e a configuração de prazo adiciona complexidade que ficará fora da plataforma por ora.

Esta feature dá ao coordenador controle sobre três eixos do sorteio: quais documentos são elegíveis (filtros por codificações existentes, por status de atribuição, por lote anterior e seleção manual), como o sorteio interage com atribuições pendentes (acrescentar vs substituir) e quem participa (toggle individual por membro). Além disso, remove a configuração de prazo do dialog.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Filtrar documentos elegíveis por codificações e atribuições (Priority: P1)

O coordenador abre o dialog de sorteio e restringe o conjunto de documentos elegíveis: por exemplo, apenas documentos que ainda não receberam nenhuma codificação humana, ou que receberam no máximo uma, ou que ainda não foram atribuídos a ninguém. A contagem de documentos elegíveis exibida no dialog atualiza conforme os filtros mudam, e o sorteio distribui apenas os documentos que passam nos filtros.

**Why this priority**: É o pedido central da feature — sem isso o coordenador não consegue direcionar o esforço da equipe para documentos descobertos ou subcodificados.

**Independent Test**: Num projeto onde parte dos documentos já tem codificação, configurar o filtro "sem nenhuma codificação" e sortear; verificar que apenas documentos sem codificação receberam atribuições novas.

**Acceptance Scenarios**:

1. **Given** um projeto com 107 documentos dos quais 40 já têm ao menos uma codificação humana, **When** o coordenador filtra por "sem nenhuma codificação", **Then** o dialog informa 67 documentos elegíveis e o sorteio distribui somente esses 67.
2. **Given** o mesmo projeto, **When** o coordenador filtra por "no máximo 1 codificação", **Then** documentos com 2 ou mais codificações ficam de fora do sorteio.
3. **Given** documentos já atribuídos e pendentes, **When** o coordenador filtra por "sem atribuição ativa do tipo sorteado", **Then** documentos com atribuição pendente ou em andamento daquele tipo não entram no sorteio.
4. **Given** filtros combinados (ex.: sem codificação E nunca atribuído), **When** o coordenador os ativa simultaneamente, **Then** apenas documentos que satisfazem todos os filtros ao mesmo tempo são elegíveis.

---

### User Story 2 - Sortear lote novo sem destruir atribuições pendentes (Priority: P1)

O coordenador escolhe explicitamente, no dialog, se o sorteio acrescenta atribuições às existentes (padrão) ou se substitui as pendentes do tipo sorteado (comportamento atual). No modo acrescentar, atribuições pendentes de lotes anteriores permanecem intactas e ninguém recebe o mesmo documento duas vezes no mesmo tipo.

**Why this priority**: Sem o modo acrescentar, qualquer sorteio novo apaga o trabalho pendente do lote anterior — os filtros da User Story 1 perdem o principal caso de uso (lotes incrementais).

**Independent Test**: Sortear um "Lote 1", depois sortear um "Lote 2" em modo acrescentar e verificar que todas as atribuições pendentes do Lote 1 continuam existindo, sem duplicidades.

**Acceptance Scenarios**:

1. **Given** atribuições pendentes de um sorteio anterior, **When** o coordenador sorteia em modo acrescentar, **Then** nenhuma atribuição pendente preexistente é removida ou alterada.
2. **Given** atribuições pendentes de um sorteio anterior, **When** o coordenador sorteia em modo substituir, **Then** as pendentes do tipo sorteado são descartadas e redistribuídas, preservando as em andamento e concluídas (comportamento atual).
3. **Given** um participante que já tem atribuição ativa de um documento, **When** um novo sorteio em modo acrescentar inclui esse documento, **Then** o documento só é atribuído a outros participantes — nunca duas vezes à mesma pessoa no mesmo tipo.
4. **Given** qualquer modo, **When** o sorteio executa, **Then** atribuições em andamento ou concluídas jamais são alteradas.

---

### User Story 3 - Controlar quem participa do sorteio (Priority: P2)

O coordenador vê a lista de todos os membros do projeto com um toggle por pessoa: pesquisadores ligados por padrão, coordenadores desligados. Pode desligar um pesquisador (ex.: de licença, ou que já cumpriu sua cota) e ligar um coordenador. A estimativa de documentos por participante atualiza conforme os toggles mudam.

**Why this priority**: Equipes reais têm gente entrando e saindo de cena; sem isso o coordenador recorre a contornos manuais (sortear e apagar depois as atribuições de quem não deveria participar).

**Independent Test**: Desligar um pesquisador, sortear e verificar que ele não recebeu nenhuma atribuição nova.

**Acceptance Scenarios**:

1. **Given** o dialog aberto, **When** o coordenador desliga um pesquisador, **Then** esse pesquisador não recebe atribuições novas nesse sorteio e a estimativa por participante é recalculada.
2. **Given** o dialog aberto, **When** o coordenador liga um coordenador, **Then** esse coordenador entra no pool de distribuição em igualdade com os pesquisadores ativos.
3. **Given** todos os toggles desligados, **When** o coordenador tenta sortear, **Then** o sorteio fica bloqueado com mensagem explicando que é preciso ao menos um participante.

---

### User Story 4 - Filtrar documentos por lote anterior (Priority: P2)

O coordenador filtra a elegibilidade com base nos lotes de sorteio anteriores: excluir documentos que já entraram em determinados lotes, ou restringir o sorteio aos documentos de um lote específico.

**Why this priority**: Complementa os lotes incrementais — permite, por exemplo, re-sortear só o conteúdo de um lote problemático ou garantir que o Lote 2 não repita documentos do Lote 1 mesmo quando as atribuições já foram concluídas.

**Independent Test**: Sortear um lote rotulado, depois configurar um segundo sorteio excluindo esse lote e verificar que nenhum documento do primeiro lote foi redistribuído.

**Acceptance Scenarios**:

1. **Given** um lote anterior rotulado "Lote 1", **When** o coordenador exclui o "Lote 1" da elegibilidade, **Then** nenhum documento que recebeu atribuição naquele lote entra no novo sorteio.
2. **Given** lotes anteriores, **When** o coordenador restringe o sorteio aos documentos de um lote específico, **Then** apenas documentos daquele lote são elegíveis.

---

### User Story 5 - Selecionar manualmente os documentos do sorteio (Priority: P3)

O coordenador abre uma lista pesquisável dos documentos do projeto e marca individualmente quais devem participar do sorteio. A seleção manual compõe com os demais filtros por interseção.

**Why this priority**: Cobre os casos que nenhum filtro automático captura (ex.: um conjunto temático escolhido a dedo), mas é o controle mais trabalhoso de usar e o menos frequente.

**Independent Test**: Selecionar manualmente 5 documentos, sortear e verificar que apenas esses 5 receberam atribuições.

**Acceptance Scenarios**:

1. **Given** a seleção manual com 5 documentos marcados, **When** o coordenador sorteia, **Then** apenas esses 5 documentos são distribuídos.
2. **Given** seleção manual combinada com o filtro "sem nenhuma codificação", **When** algum documento marcado já tem codificação, **Then** esse documento não entra no sorteio (vale a interseção dos critérios).

---

### User Story 6 - Sortear sem configurar prazo (Priority: P3)

O dialog de sorteio não oferece mais configuração de prazo (nem prazo único, nem recorrente). Sorteios novos são criados sem prazo e a prévia não exibe coluna de prazo. Prazos definidos em sorteios antigos continuam visíveis no restante da plataforma até a remoção completa, tratada separadamente.

**Why this priority**: Simplificação decidida — o controle de prazo ficará fora da plataforma por ora —, mas de baixo impacto funcional imediato.

**Independent Test**: Abrir o dialog e verificar a ausência da seção de prazo; sortear e verificar que as atribuições criadas não têm prazo.

**Acceptance Scenarios**:

1. **Given** o dialog aberto, **When** o coordenador percorre todas as opções, **Then** não existe nenhuma configuração de prazo.
2. **Given** um sorteio executado, **When** as atribuições são criadas, **Then** nenhuma delas carrega prazo.

---

### Edge Cases

- Filtros que resultam em 0 documentos elegíveis: o dialog informa a contagem zerada e o botão de sortear fica desabilitado, com mensagem explicando o motivo.
- Todos os participantes desligados: sorteio bloqueado com mensagem clara (User Story 3, cenário 3).
- Seleção manual combinada com subconjunto aleatório de N documentos: o subconjunto amostra dentro da seleção manual (e dos demais filtros).
- Modo acrescentar quando todos os documentos elegíveis já têm suas vagas preenchidas por atribuições ativas: nada a distribuir; o dialog informa 0 elegíveis em vez de falhar silenciosamente.
- Filtro "no máximo N codificações" combinado com o tipo comparação: a exigência mínima de codificações para comparação continua valendo; se a combinação tornar o conjunto vazio (ex.: máx. 1 codificação quando comparação exige 2), o dialog mostra 0 elegíveis e orienta o coordenador.
- Limite de documentos por participante menor que a demanda total: documentos podem ficar com menos atribuições do que o solicitado (comportamento atual, mantido); a prévia evidencia o déficit.
- Participante desligado que já tinha atribuições pendentes: as atribuições existentes dele não são tocadas em modo acrescentar; em modo substituir, as pendentes dele do tipo sorteado são descartadas junto com as demais e ele não recebe novas.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O dialog de sorteio MUST oferecer filtro de elegibilidade por número de codificações humanas do documento, com as opções: todos os documentos, sem nenhuma codificação, com no máximo N codificações (N configurável pelo coordenador).
- **FR-002**: Para o filtro de codificações, o sistema MUST contar apenas a codificação mais recente de cada pessoa por documento (re-codificações da mesma pessoa não contam em dobro) e MUST ignorar codificações geradas por máquina.
- **FR-003**: O dialog MUST oferecer filtro por status de atribuição do documento, com as opções: qualquer, sem atribuição ativa do tipo sorteado (pendente ou em andamento), nunca atribuído em nenhum tipo.
- **FR-004**: O dialog MUST oferecer filtro por lote de sorteio anterior, permitindo excluir documentos pertencentes a lotes selecionados ou restringir a elegibilidade aos documentos de um lote específico.
- **FR-005**: O dialog MUST permitir seleção manual de documentos numa lista pesquisável, identificando cada documento de forma reconhecível pelo coordenador.
- **FR-006**: Os filtros MUST compor por interseção (todos os critérios ativos valem simultaneamente), e o subconjunto aleatório de N documentos, quando ativado, MUST amostrar somente dentro do conjunto já filtrado.
- **FR-007**: O dialog MUST exibir a contagem de documentos elegíveis e a estimativa de documentos por participante, atualizadas a cada mudança de filtro, modo ou participante; com 0 elegíveis ou 0 participantes, o sorteio MUST ficar desabilitado com mensagem explicativa.
- **FR-008**: O dialog MUST oferecer a escolha entre modo acrescentar (padrão) e modo substituir. No modo acrescentar, o sorteio MUST preservar todas as atribuições existentes e distribuir apenas vagas remanescentes; no modo substituir, o sorteio MUST descartar somente as atribuições pendentes do tipo sorteado antes de redistribuir.
- **FR-009**: Em qualquer modo, o sorteio MUST NOT atribuir o mesmo documento mais de uma vez à mesma pessoa no mesmo tipo e MUST NOT alterar atribuições em andamento ou concluídas.
- **FR-010**: O dialog MUST listar todos os membros do projeto com um controle individual de participação: pesquisadores ativados por padrão, coordenadores desativados por padrão.
- **FR-011**: Para sorteios do tipo comparação, o sistema MUST continuar exigindo o número mínimo de codificações por documento configurado no projeto, e os filtros desta feature MUST compor por cima dessa exigência.
- **FR-012**: O dialog MUST NOT oferecer configuração de prazo; sorteios novos MUST ser criados sem prazo e a prévia MUST NOT exibir informação de prazo. Prazos de sorteios antigos permanecem intactos onde já são exibidos.
- **FR-013**: A prévia MUST refletir exatamente o resultado que o sorteio produziria com a configuração corrente (filtros, modo, participantes, limites), incluindo quantidade de atribuições novas e preservadas por participante.
- **FR-014**: O sorteio MUST manter a distribuição equilibrada existente: variação de duplas de participantes por documento e respeito ao limite de documentos por participante.
- **FR-015**: O rótulo do lote MUST continuar opcional e MUST ser registrado junto com a configuração usada no sorteio (filtros, modo e participantes), para consulta posterior.

### Key Entities

- **Documento**: unidade de análise do projeto; acumula codificações humanas e pode estar ativo ou excluído (excluídos nunca são elegíveis).
- **Codificação**: resposta de uma pessoa a um documento; só a versão mais recente de cada pessoa conta para os filtros de elegibilidade.
- **Atribuição**: vínculo entre documento, participante e tipo de tarefa (codificação ou comparação), com estados pendente, em andamento e concluído.
- **Lote de sorteio**: registro de cada execução do sorteio, com rótulo opcional e a configuração usada; base do filtro por lote anterior.
- **Participante**: membro do projeto (pesquisador ou coordenador) que pode ser incluído ou excluído de cada sorteio individualmente.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O coordenador consegue criar um lote incremental contendo apenas documentos sem codificação com 0 atribuições pendentes preexistentes afetadas (modo acrescentar).
- **SC-002**: A contagem de documentos elegíveis exibida no dialog corresponde a 100% dos documentos efetivamente distribuídos ou distribuíveis pelo sorteio com aquela configuração.
- **SC-003**: Após qualquer sequência de sorteios, não existe nenhuma duplicidade de documento + pessoa + tipo nas atribuições.
- **SC-004**: O coordenador completa o fluxo configurar filtros → conferir prévia → sortear em menos de 1 minuto num projeto com cerca de 100 documentos.
- **SC-005**: A prévia coincide com o resultado real do sorteio em 100% das execuções com a mesma configuração (mesmas contagens por participante).

## Assumptions

- "Revisão" no pedido original significa codificação humana registrada para o documento; codificações geradas por máquina não contam para os filtros de elegibilidade.
- O modo acrescentar é o padrão por ser o comportamento seguro (não destrutivo); o modo substituir preserva o fluxo atual de re-sortear do zero.
- A remoção completa do controle de prazo da plataforma (tabela de atribuições, página de progresso, dados históricos) é tratada em demanda separada; esta feature remove apenas a configuração de prazo do dialog de sorteio.
- Os tipos de tarefa atribuídos automaticamente por outros fluxos (auto-revisão e arbitragem) estão fora do escopo do sorteio.
- O algoritmo de balanceamento da distribuição não muda; a feature controla apenas a entrada dele (documentos elegíveis, participantes, modo).

## Out of Scope

- Remoção completa do controle de prazo da plataforma (indicadores de atraso, página de progresso pessoal, dados históricos) — registrada como issue separada.
- Qualquer controle de prazo dentro ou fora do dialog.
- Sorteio ou gestão de tarefas de auto-revisão e arbitragem.
- Alterações no algoritmo de balanceamento de duplas e cargas.
- Filtros por metadados ou conteúdo dos documentos.
