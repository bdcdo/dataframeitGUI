# Feature Specification: Melhorar o sorteio de atribuições

**Feature Branch**: `001-improve-assignment-lottery`

**Created**: 2026-06-10

**Status**: Draft

**Input**: User description: "quero melhorar a funcionalidade de sortear atribuições. Acho incompleta e pouco funcional. Deveríamos poder selecionar só documentos sem revisão, com no máximo uma revisão, etc. Acho que podemos remover a questão do prazo, porque o controle de prazo por enquanto pode ficar de fora da plataforma."

**Input (2026-06-11)**: User description: "o sorteio atual acho que tá sempre mandando pareceres (todos os da rodada) para quem inicia a rodada com menos pareceres. A distribuição de novos pareceres deve buscar equilibrio entre os pesquisadores, mas acho que é melhor configurar entre equilibrar só com base na rodada e equilibrar com base em rodadas anteriores. Acho que mesmo considerando rodadas anteriores tá meio bugado"

## Visão geral

O sorteio de atribuições distribui documentos do projeto entre os participantes para codificação ou comparação. Hoje o coordenador não controla quais documentos entram no sorteio (todo documento ativo com vaga participa), cada sorteio descarta as atribuições pendentes do tipo e redistribui tudo — o que inviabiliza lotes incrementais —, o conjunto de participantes é rígido (todos os pesquisadores, sempre) e a configuração de prazo adiciona complexidade que ficará fora da plataforma por ora. Além disso, a distribuição concentra documentos: dependendo da configuração, todos os documentos de uma rodada vão para o participante que começou com menos atribuições (ou para os mesmos participantes de sempre), em vez de se espalharem com equilíbrio pela equipe.

Esta feature dá ao coordenador controle sobre quatro eixos do sorteio: quais documentos são elegíveis (filtros por codificações existentes, por status de atribuição, por lote anterior e seleção manual), como o sorteio interage com atribuições pendentes (acrescentar vs substituir), quem participa (toggle individual por membro) e como a distribuição equilibra a carga entre os participantes (só a rodada atual vs considerando rodadas anteriores). Além disso, remove a configuração de prazo do dialog.

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

### User Story 7 - Equilibrar a distribuição entre os participantes (Priority: P1)

O coordenador escolhe no dialog como o sorteio equilibra a carga: "equilibrar só esta rodada" (padrão) divide os documentos do sorteio atual igualmente entre os participantes, ignorando cargas anteriores; "equilibrar considerando rodadas anteriores" direciona mais documentos a quem tem menos carga acumulada, até nivelar os totais. Em qualquer modo, a distribuição se espalha pela equipe — nunca concentra todos os documentos num único participante enquanto outros têm capacidade disponível.

**Why this priority**: Corrige um defeito observado em uso real — rodadas inteiras indo para uma única pessoa (a que começou com menos atribuições, ou sempre as mesmas pessoas da lista) — que mina a confiança da equipe no sorteio e obriga o coordenador a redistribuir na mão.

**Independent Test**: Num projeto com 3 participantes de cargas acumuladas diferentes, sortear 12 documentos no modo "só esta rodada" e verificar que cada participante recebeu 4 atribuições novas; repetir no modo "rodadas anteriores" e verificar que quem tinha menos carga recebeu mais, sem ninguém receber tudo.

**Acceptance Scenarios**:

1. **Given** D documentos elegíveis, R participantes por documento e P participantes ativos sem limite de documentos por participante, **When** o coordenador sorteia no modo "equilibrar só esta rodada", **Then** cada participante recebe entre ⌊D·R/P⌋ e ⌈D·R/P⌉ atribuições novas, independentemente da carga que cada um tinha antes.
2. **Given** participantes com cargas acumuladas diferentes (atribuições pendentes, em andamento e concluídas do tipo sorteado), **When** o coordenador sorteia no modo "equilibrar considerando rodadas anteriores", **Then** quem tem menor carga acumulada recebe proporcionalmente mais documentos novos, aproximando os totais ao final do sorteio.
3. **Given** qualquer modo de equilíbrio e mais de um participante com capacidade disponível, **When** o sorteio executa, **Then** nenhum participante único recebe todos os documentos da rodada.
4. **Given** participantes empatados pelo critério do modo escolhido, **When** o sorteio decide quem recebe o próximo documento, **Then** o desempate é aleatório — a ordem de cadastro dos membros no projeto não influencia o resultado.

---

### Edge Cases

- Filtros que resultam em 0 documentos elegíveis: o dialog informa a contagem zerada e o botão de sortear fica desabilitado, com mensagem explicando o motivo.
- Todos os participantes desligados: sorteio bloqueado com mensagem clara (User Story 3, cenário 3).
- Seleção manual combinada com subconjunto aleatório de N documentos: o subconjunto amostra dentro da seleção manual (e dos demais filtros).
- Modo acrescentar quando todos os documentos elegíveis já têm suas vagas preenchidas por atribuições ativas: nada a distribuir; o dialog informa 0 elegíveis em vez de falhar silenciosamente.
- Filtro "no máximo N codificações" combinado com o tipo comparação: a exigência mínima de codificações para comparação continua valendo; se a combinação tornar o conjunto vazio (ex.: máx. 1 codificação quando comparação exige 2), o dialog mostra 0 elegíveis e orienta o coordenador.
- Limite de documentos por participante menor que a demanda total: documentos podem ficar com menos atribuições do que o solicitado (comportamento atual, mantido); a prévia evidencia o déficit.
- Participante desligado que já tinha atribuições pendentes: as atribuições existentes dele não são tocadas em modo acrescentar; em modo substituir, as pendentes dele do tipo sorteado são descartadas junto com as demais e ele não recebe novas.
- Membro novo (carga acumulada zero) no modo "rodadas anteriores": recebe mais documentos que os demais até nivelar — comportamento esperado do modo, não defeito; a prévia evidencia a assimetria antes de o coordenador confirmar.
- Modo "só esta rodada" com limite de documentos por participante menor que a cota uniforme (⌈D·R/P⌉): o participante para no limite e o excedente é redistribuído entre os demais com capacidade; se ninguém tem capacidade, documentos ficam com menos atribuições que o solicitado (déficit evidenciado na prévia).
- Modo "rodadas anteriores" com cargas já niveladas: a distribuição degenera para a uniforme — equivalente ao modo "só esta rodada" para aquele sorteio.
- Dados do projeto mudam entre a prévia e o sorteio (outro sorteio executado, atribuições alteradas): o sorteio recalcula sobre os dados atuais e pode divergir da prévia — a igualdade garantida (SC-005) vale para configuração e dados inalterados. Sortear sem prévia produz aleatorização nova, sem compromisso com prévias anteriores.

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
- **FR-013**: A prévia MUST refletir exatamente o resultado que o sorteio produziria com a configuração corrente (filtros, modos, participantes, limites), incluindo quantidade de atribuições novas e preservadas por participante. Ao sortear a partir de uma prévia, sem mudança de configuração nem dos dados do projeto, o resultado MUST ser idêntico ao previsualizado; sorteios sem prévia, ou após mudança de configuração ou de dados, produzem nova aleatorização.
- **FR-014**: O sorteio MUST manter a variação de duplas de participantes por documento e o respeito ao limite de documentos por participante, em ambos os modos de equilíbrio.
- **FR-015**: O rótulo do lote MUST continuar opcional e MUST ser registrado junto com a configuração usada no sorteio (filtros, modo de atribuição, modo de equilíbrio e participantes), para consulta posterior.
- **FR-016**: O dialog MUST oferecer a escolha do modo de equilíbrio da distribuição, com as opções "equilibrar só esta rodada" (padrão) e "equilibrar considerando rodadas anteriores".
- **FR-017**: No modo "equilibrar só esta rodada", o sorteio MUST distribuir as atribuições novas da forma mais uniforme possível entre os participantes ativos — diferença máxima de 1 atribuição entre quaisquer dois participantes, salvo quando limites de capacidade ou restrições de elegibilidade impedirem —, sem considerar a carga acumulada de rodadas anteriores.
- **FR-018**: No modo "equilibrar considerando rodadas anteriores", o sorteio MUST priorizar os participantes com menor carga acumulada, contando as atribuições do tipo sorteado preservadas pelo modo corrente — em modo acrescentar: pendentes, em andamento e concluídas; em modo substituir: em andamento e concluídas (as pendentes do tipo são descartadas pelo próprio sorteio e deixam de existir como carga).
- **FR-019**: Em qualquer modo de equilíbrio, desempates entre participantes MUST ser resolvidos aleatoriamente; a ordem de cadastro dos membros no projeto MUST NOT influenciar quem recebe cada documento.

### Key Entities

- **Documento**: unidade de análise do projeto; acumula codificações humanas e pode estar ativo ou excluído (excluídos nunca são elegíveis).
- **Codificação**: resposta de uma pessoa a um documento; só a versão mais recente de cada pessoa conta para os filtros de elegibilidade.
- **Atribuição**: vínculo entre documento, participante e tipo de tarefa (codificação ou comparação), com estados pendente, em andamento e concluído.
- **Lote de sorteio**: registro de cada execução do sorteio, com rótulo opcional e a configuração usada (incluindo o modo de equilíbrio); base do filtro por lote anterior. "Rodada" é o mesmo conceito na linguagem da UI do equilíbrio — o termo canônico dos artefatos é lote.
- **Participante**: membro do projeto (pesquisador ou coordenador) que pode ser incluído ou excluído de cada sorteio individualmente.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: O coordenador consegue criar um lote incremental contendo apenas documentos sem codificação com 0 atribuições pendentes preexistentes afetadas (modo acrescentar).
- **SC-002**: A contagem de documentos elegíveis exibida no dialog corresponde a 100% dos documentos efetivamente distribuídos ou distribuíveis pelo sorteio com aquela configuração.
- **SC-003**: Após qualquer sequência de sorteios, não existe nenhuma duplicidade de documento + pessoa + tipo nas atribuições.
- **SC-004**: O coordenador completa o fluxo configurar filtros → conferir prévia → sortear em menos de 1 minuto num projeto com cerca de 100 documentos.
- **SC-005**: O sorteio executado a partir de uma prévia, sem mudança de configuração nem dos dados do projeto, coincide com ela em 100% das execuções (mesmas contagens por participante).
- **SC-006**: No modo "equilibrar só esta rodada" sem limites de capacidade, 100% dos sorteios resultam em cada participante com ⌊D·R/P⌋ a ⌈D·R/P⌉ atribuições novas (D documentos, R participantes por documento, P participantes ativos).
- **SC-007**: No modo "equilibrar considerando rodadas anteriores", nenhum participante com folga de capacidade termina o sorteio com 2 ou mais atribuições acumuladas a menos que outro participante enquanto havia documento elegível que poderia ter ido para ele.

## Assumptions

- "Revisão" no pedido original significa codificação humana registrada para o documento; codificações geradas por máquina não contam para os filtros de elegibilidade.
- O modo acrescentar é o padrão por ser o comportamento seguro (não destrutivo); o modo substituir preserva o fluxo atual de re-sortear do zero.
- A remoção completa do controle de prazo da plataforma (tabela de atribuições, página de progresso, dados históricos) é tratada em demanda separada; esta feature remove apenas a configuração de prazo do dialog de sorteio.
- Os tipos de tarefa atribuídos automaticamente por outros fluxos (auto-revisão e arbitragem) estão fora do escopo do sorteio.
- O modo de equilíbrio padrão é "equilibrar só esta rodada", por ser o comportamento mais previsível: cada sorteio sai equilibrado por si, independentemente do histórico (decidido com o usuário em 2026-06-11).
- No modo "equilibrar considerando rodadas anteriores", a carga acumulada de um participante conta as atribuições pendentes, em andamento e concluídas do tipo sorteado — incluir as pendentes corrige a distorção observada de o equilíbrio histórico ignorar trabalho já distribuído e ainda não iniciado (decidido com o usuário em 2026-06-11).

## Out of Scope

- Remoção completa do controle de prazo da plataforma (indicadores de atraso, página de progresso pessoal, dados históricos) — registrada como issue separada.
- Qualquer controle de prazo dentro ou fora do dialog.
- Sorteio ou gestão de tarefas de auto-revisão e arbitragem.
- Filtros por metadados ou conteúdo dos documentos.
- Pesos individuais de carga por participante (ex.: meio período recebe metade da cota) — o equilíbrio trata todos os participantes ativos como equivalentes.
