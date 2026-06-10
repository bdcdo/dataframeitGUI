# Research: Melhorar o sorteio de atribuições

**Feature**: 001-improve-assignment-lottery | **Date**: 2026-06-10

O Technical Context não tem NEEDS CLARIFICATION — stack e padrões são os do projeto. Este documento consolida as decisões de desenho que a implementação deve seguir, com alternativas consideradas.

## D1. Onde a elegibilidade é calculada

**Decision**: função pura `filterEligibleDocs(docStats, filters)` em `frontend/src/lib/lottery-utils.ts`, aplicada em dois lugares: (a) no client do dialog, sobre stats pré-carregadas, para contagem ao vivo e lista de seleção manual; (b) no server, dentro de `computeLottery`, como fonte de verdade para preview e execução.

**Rationale**: FR-007 exige contagem de elegíveis atualizada a cada mudança de filtro — round-trip por tecla/toggle seria lento e gastaria requests; filtrar client-side sobre stats leves é instantâneo. Reaplicar a mesma função no server elimina divergência entre o que o dialog mostra e o que o sorteio faz (SC-002), no mesmo padrão de primitivas puras compartilhadas usado em `schema-utils.ts` (anti-drift, cf. #63).

**Alternatives considered**: (1) Server Action debounced para contar elegíveis — latência perceptível, mais carga, e a lista da seleção manual precisaria das stats de qualquer forma. (2) Filtrar só no client e confiar nos ids enviados — o server não pode confiar em lista filtrada pelo client (RLS protege dados, mas a regra de negócio ficaria burlável e o preview mentiria se as stats estivessem stale).

## D2. Formato das estatísticas por documento (`getLotteryDocStats`)

**Decision**: nova Server Action de leitura `getLotteryDocStats(projectId)` que retorna, por documento ativo: `{ id, externalId, title, humanCodingCount, activeAssignments: { codificacao: number; comparacao: number }, hasAnyAssignmentEver: boolean, batchIds: string[] }`, mais a lista de lotes `{ id, label, createdAt }`. Três queries em `Promise.all`, com colunas explícitas: documentos ativos (`id, external_id, title`), respostas humanas latest (`document_id, respondent_id` com `is_latest = true` e `respondent_type = 'humano'`), atribuições (`document_id, user_id, status, type, batch_id`), e `assignment_batches` (`id, label, created_at`). Agregação em memória no server.

**Rationale**: `humanCodingCount` = nº de respondentes humanos distintos com resposta `is_latest` (FR-002: re-codificações da mesma pessoa não contam em dobro; LLM fica de fora). O índice parcial `idx_responses_project_is_latest` cobre o filtro. Payload para 5.000 docs ≈ centenas de KB no máximo — aceitável para um fetch único na abertura do dialog. `batchIds` vem de `assignments.batch_id` (presente e histórico de não-pendentes), que é o registro disponível de pertencimento a lote.

**Alternatives considered**: (1) View SQL agregada — mais rápido em projetos gigantes, porém adiciona migration e RLS surface sem necessidade na escala atual; pode ser otimização futura. (2) `responses(count)` por join — não distingue respondente distinto nem `respondent_type`.

**Limitação documentada**: documento cujas atribuições pendentes de um lote foram apagadas por um sorteio "substituir" perde o vínculo com aquele lote (o `batch_id` morava na atribuição apagada). O filtro por lote opera sobre os vínculos existentes — comportamento aceito e documentado na UI ("docs que possuem atribuições do lote X").

## D3. Representação dos filtros em `LotteryParams`

**Decision**: estender `LotteryParams` com:

```ts
mode: "append" | "replace";                  // default "append"
maxHumanCodings?: number;                    // undefined = todos; 0 = sem nenhuma; N = no máximo N
assignmentFilter?: "any" | "noActiveOfType" | "neverAssigned";  // default "any"
batchFilter?: { exclude?: string[]; only?: string };
manualDocIds?: string[];
participantIds: string[];                    // substitui includedCoordinatorIds
```

e remover `deadlineMode`, `deadlineDate`, `recurringCount`, `recurringStart`.

**Rationale**: `maxHumanCodings` cobre as três opções do FR-001 com um único campo (radio na UI: todos / sem nenhuma → 0 / no máximo N → input). `participantIds` explícito torna o pool determinístico e auditável (FR-015) em vez do implícito "todos os pesquisadores + coordenadores marcados". Composição por interseção (FR-006) é a ordem de aplicação dentro de `filterEligibleDocs`: ativos → manual → codificações → status de atribuição → lote; subconjunto aleatório amostra depois, em `computeLottery`.

**Alternatives considered**: union types discriminados por filtro (`{kind:"none"}|{kind:"atMost",max}`) — mais cerimônia sem ganho; campos opcionais simples bastam e serializam direto para o JSONB do lote.

## D4. Modo acrescentar vs substituir em `computeLottery`/`smartRandomize`

**Decision**: em `computeLottery`, o conjunto "preservado" passa a depender do modo — `replace`: atribuições `em_andamento`/`concluido` do tipo (comportamento atual); `append`: **todas** as atribuições do tipo, inclusive `pendente`. Todo o restante do algoritmo (contagem por doc, capacidade por participante, `preservedSet` anti-duplicidade, matriz de co-ocorrência) já opera sobre esse conjunto, então passa a respeitar pendentes automaticamente. Em `smartRandomize`, o `DELETE` de pendentes só executa em `replace`.

**Rationale**: é a menor mudança que satisfaz FR-008/FR-009: o invariante de unicidade (`UNIQUE(document_id, user_id, type)`) continua garantido pelo `preservedSet` + constraint do banco; atribuições em andamento/concluídas nunca entram no delete em nenhum modo. Capacidade (`docsPerResearcher`) em append conta pendentes existentes — coerente com a semântica de "limite de docs por pesquisador".

**Alternatives considered**: transação/RPC Postgres para delete+insert atômicos — desejável em tese, mas o padrão atual (delete + insert em chunks via PostgREST) já é o vigente e o modo append nem usa delete; fica fora do escopo (sem regressão).

## D5. Participantes: lista única com toggle

**Decision**: o dialog recebe `members: { userId, name, role }[]` (pesquisadores + coordenadores, nomes já carregados pela page de atribuições) e renderiza uma seção única "Participantes" com Switch por pessoa — pesquisadores ON, coordenadores OFF por default (FR-010). `buildParams` envia `participantIds` = ids ligados. No server, `computeLottery` valida os ids contra `project_members` do projeto (qualquer role) e usa exatamente essa lista como pool, eliminando o fetch interno de "todos os pesquisadores".

**Rationale**: o server não pode confiar em ids arbitrários (defesa em profundidade além do RLS); validar contra `project_members` mantém a regra "participante = membro do projeto". A page já tem `typedResearchers`/`typedCoordinators` com nome/email — zero query nova.

**Alternatives considered**: manter pool implícito + `excludedResearcherIds` — preserva a API atual, mas duplica a semântica (incluído por default vs excluído explícito) e complica o registro da configuração no lote.

## D6. Seleção manual de documentos

**Decision**: componente novo `DocumentPickerList` dentro do dialog (Switch "Selecionar documentos manualmente" liga a lista): input de busca client-side por título/`external_id` + lista com checkbox por doc e contador "N selecionados", usando as stats já carregadas (D2). Sem virtualização inicialmente; lista com `max-h` + scroll.

**Rationale**: os dados já estão no client (D2), então a busca é filtragem de array. Para a escala-alvo (centenas a poucos milhares de docs), uma lista com scroll basta; virtualização (ex.: `@tanstack/react-virtual`) só se a prática mostrar jank — anotar como follow-up, não dependência nova agora (regra: sem dependência pesada sem necessidade).

**Alternatives considered**: dialog separado de seleção — mais cliques e estado a sincronizar; Command/combobox multi-select do shadcn — bom para poucos itens, ruim para marcar dezenas.

## D7. Registro da configuração do sorteio (FR-015)

**Decision**: migration aditiva em `assignment_batches`: `mode TEXT NOT NULL DEFAULT 'replace' CHECK (mode IN ('append','replace'))` e `filters JSONB` (snapshot de `maxHumanCodings`, `assignmentFilter`, `batchFilter`, `manualDocIds` (apenas contagem + ids), `participantIds`, `docSubsetSize`). Colunas de deadline existentes ficam intocadas (passam a receber `'none'`/NULL por default).

**Rationale**: `mode` como coluna tipada (consultável); `filters` como JSONB evita o sprawl de ~6 colunas para dados que são só auditoria/consulta. Default `'replace'` descreve corretamente os lotes históricos (todos foram substitutivos).

**Alternatives considered**: colunas individuais para cada filtro (padrão dos campos de 2026-03) — mais rígido e exige nova migration a cada filtro futuro; tudo em JSONB inclusive mode — perde a checagem de domínio barata.

## D8. Remoção do prazo (FR-012)

**Decision**: remover do dialog a seção Prazo (Collapsible, Calendars, estados), remover os campos de deadline de `LotteryParams` e do `computeLottery` (passo 11 inteiro), inserir atribuições sem `deadline` (coluna fica NULL) e gravar `deadline_mode: 'none'` no lote. A coluna "Prazo" sai da tabela de preview. `AssignmentTable`, `progress.ts` e página my-progress **não são tocados** (issue #176 cobre a remoção completa).

**Rationale**: decisão de escopo confirmada na spec; colunas do banco intactas tornam o passo reversível e não conflitam com a issue #176.

## D9. Zero elegíveis / zero participantes (FR-007)

**Decision**: no client, botões "Visualizar prévia" e "Sortear" desabilitados quando `eligibleCount === 0` ou `participantIds.length === 0`, com mensagem contextual no lugar da estimativa (ex.: "Nenhum documento passa nos filtros atuais"). No server, `computeLottery` valida e lança erros claros (mantém o padrão de `throw new Error` + toast), cobrindo chamadas com stats stale.

**Rationale**: feedback imediato no client + validação autoritativa no server; o erro de comparação existente ("Nenhum documento tem respostas suficientes…") permanece e ganha o equivalente para filtros.

## D10. Testes

**Decision**: unit tests Vitest para `filterEligibleDocs` cobrindo: cada filtro isolado, composição por interseção, `maxHumanCodings` 0/N, interação com tipo comparação (exigência mínima preservada — FR-011), seleção manual ∩ filtros, e casos de borda da spec (0 elegíveis). A distribuição (`computeLottery`) permanece testada indiretamente — extrair seu núcleo puro fica como refactor futuro se necessário.

**Rationale**: a função pura é o ponto de maior risco lógico novo e é trivialmente testável; o algoritmo de distribuição não muda (FR-014).
