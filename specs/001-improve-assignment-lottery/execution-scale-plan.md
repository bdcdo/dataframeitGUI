# Plano proposto para escalar o caminho de execução do sorteio

**Status:** proposta; nenhum benchmark foi executado nesta elaboração

**Issue:** [#409](https://github.com/bdcdo/dataframeitGUI/issues/409)

**Referências:** [issue #182](https://github.com/bdcdo/dataframeitGUI/issues/182), [PR #408](https://github.com/bdcdo/dataframeitGUI/pull/408), [`research.md` D2, D12 e D13](./research.md)

**Data:** 2026-07-15

## Decisão resumida

O próximo passo recomendado é substituir o fetch bruto de `assignments` em `computeLottery` por uma RPC de leitura que devolva exatamente quatro resultados do conjunto preservado: contagem total preservada, usuários já atribuídos por documento candidato, carga preservada por participante e matriz esparsa de coocorrência. A distribuição continua em TypeScript, na função pura `distributeDocs`; filtros, pesos, capacidades, PRNG e persistência não mudam.

A RPC deve filtrar `project_id`, `type` e os status preservados antes de agregar. Ela não pode descartar histórico por idade, porque isso mudaria o modo `history` e o desempate por variação de duplas. Uma migration adiciona um índice cobrindo o caminho. Implementação só começa depois do protocolo deste documento medir o baseline no mesmo dataset e confirmar equivalência exata com um oracle canônico.

## Estado atual verificado

[`fetchLotteryData`](../../frontend/src/actions/assignments.ts) executa hoje uma query por `project_id` com as colunas `document_id, user_id, status, type`, sem filtro de tipo, filtro de status, paginação ou ordem. Em seguida, [`computeLottery`](../../frontend/src/actions/assignments.ts) elimina em memória o tipo irrelevante e os status que o modo não preserva.

O conjunto preservado tem estas semânticas, definidas em D4 e FR-018:

- `append`: `pendente`, `em_andamento` e `concluido` do tipo sorteado.
- `replace`: `em_andamento` e `concluido` do tipo sorteado; pendentes serão removidas pela operação transacional de replace.

As linhas preservadas alimentam quatro valores: `preservedSet` para anti-duplicidade, `docAssignedUsers` e `docAssignedCount` para vagas por documento, `preservedByUser` para carga/capacidade e `coOccurrence` para o segundo critério de `distributeDocs`.

A PR #408 moveu as estatísticas da abertura do dialog para `lottery_doc_stats`, mas manteve esse fetch porque contagens simples por documento não bastam. Ela também criou `idx_assignments_project_document`; existem ainda índices separados por `(project_id, user_id)`, `(project_id, type)` e `(project_id, status)`. Não existe índice cobrindo, em uma única leitura, projeto + tipo + status + documento + usuário.

Há também um risco de correção, não apenas de latência: o repositório documenta em [`export.ts`](../../frontend/src/actions/export.ts) que PostgREST costuma limitar uma resposta a 1.000 linhas. A configuração remota precisa ser medida, mas o código de `fetchLotteryData` não pagina e não verifica a contagem total; portanto, acima do teto configurado, a matriz pode ser montada sobre um prefixo silenciosamente truncado.

## Semântica que não pode mudar

A otimização só é aceita se preservar estes invariantes:

1. O conjunto preservado contém todas e somente as linhas do tipo sorteado nos status definidos pelo modo.
2. `preservedCount` conta todas essas linhas do projeto, inclusive usuários que não participam do sorteio atual.
3. A carga acumulada de cada participante conta suas linhas preservadas em todo o projeto, não apenas nos documentos elegíveis.
4. Os usuários já atribuídos de um documento candidato incluem participantes desligados e ex-membros ainda referenciados; todos ocupam vaga e impedem duplicidade.
5. A coocorrência de um participante ativo conta cada documento preservado que ele compartilhou com qualquer outro usuário, inclusive alguém fora do pool atual.
6. `round` ignora a carga histórica como critério primário, mas continua usando pares preservados, vagas e coocorrência.
7. `history` usa a carga preservada completa, sem janela temporal.
8. Mesma configuração, mesmo snapshot de dados e mesma seed produzem exatamente a mesma sequência de novos pares documento×usuário.

## Dataset de benchmark

O protocolo usa um gerador determinístico, com seed gravada no resultado, sobre um banco descartável que contenha todas as migrations. Nenhum dado de produção é necessário.

### Escala-alvo

- 1 projeto.
- 5.000 documentos ativos.
- 30 membros, sendo 24 pesquisadores e 6 coordenadores.
- 2 tipos sorteáveis: `codificacao` e `comparacao`.
- 3 status em proporção fixa por cenário: 40% `pendente`, 20% `em_andamento`, 40% `concluido`.
- 20 lotes históricos para distribuir `batch_id`, embora a RPC proposta não precise dessa coluna.

### Cenários

| Cenário | Linhas do tipo medido | Distribuição | Finalidade |
|---|---:|---|---|
| vazio | 0 | nenhum documento atribuído | overhead fixo |
| típico | 10.000 | 2 usuários distintos por documento | uso esperado em 5.000 docs |
| assimétrico | 30.000 | cargas 0–2.000 por membro e duplas repetidas | `history`, pesos e coocorrência |
| denso | 150.000 | 30 usuários por documento | teto combinatório da escala-alvo por tipo |
| ruído de tipo | 10.000 relevantes + 150.000 do outro tipo | mesmo projeto | ganho de pushdown por `type` |

Cada cenário roda em `append` e `replace`, com 30 participantes, `researchersPerDoc = 2`, sem `docsPerResearcher`, e depois com `docSubsetSize = 500`. Uma segunda rodada usa 15 participantes para verificar que coocorrência com usuários fora do pool continua presente.

O gerador deve respeitar `UNIQUE(document_id, user_id, type)`. IDs, timestamps, lotes, status e pares são derivados da seed; o manifesto final registra contagens por tipo/status, número de documentos distintos e histograma de carga por usuário.

## Métricas e protocolo

Para cada cenário, executar 5 aquecimentos descartados e 30 medições, sempre no mesmo commit, máquina, versão do Postgres/Supabase CLI e dataset. Separar conexão fria de execução aquecida; não misturar os dois números.

Registrar:

- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` da query atual paginada de referência e da RPC proposta.
- tempo de banco, tempo total da Server Action e tempo de `distributeDocs`, em milissegundos.
- linhas lidas, linhas devolvidas e bytes UTF-8 de `JSON.stringify` do payload.
- delta e pico de `heapUsed` do processo Node em um harness dedicado; não inferir memória a partir do tamanho do JSON.
- quantidade de páginas e round-trips no loader de referência.
- pares novos, `preservedCount`, cargas por participante e hash canônico do resultado.

Antes de medir performance, uma query `count(*)` independente confirma que o loader de referência recuperou 100% das linhas. Qualquer truncamento invalida aquela rodada de benchmark; não se compara uma implementação correta contra um prefixo incompleto.

### Limiares propostos de aceite

Estes números são metas de projeto, não resultados medidos:

| Métrica | típico, 10.000 linhas | denso, 150.000 linhas |
|---|---:|---:|
| equivalência de pares e contadores | 100% | 100% |
| p95 da RPC aquecida | ≤ 750 ms | ≤ 2.000 ms |
| p95 de `computeLottery` completo | ≤ 1.500 ms | ≤ 4.000 ms |
| payload da RPC | ≤ 2 MiB | ≤ 15 MiB, teto operacional |
| pico adicional de heap Node | ≤ 128 MiB | ≤ 256 MiB |
| round-trips de estado preservado | 1 | 1 |

Se a proposta exceder qualquer limite, o resultado deve voltar para decisão de arquitetura; não se aumenta o teto sem registrar o motivo e os números. O teto de 15 MiB também é aplicado em produção, não apenas observado no benchmark. O requisito absoluto é correção de 100% — latência melhor não compensa diferença de um único par.

## Contrato de equivalência determinística

O fetch atual não usa `.order()`, então a ordem recebida do Postgres não é um contrato estável. Para tornar a comparação reproduzível, tanto o oracle quanto o caminho novo devem normalizar a entrada antes de chamar `distributeDocs`:

- `LotteryDocStats` em ordem crescente de `id`.
- `eligibleDocIds` derivados nessa ordem antes do shuffle seedado.
- `participantIds` deduplicados preservando a ordem explícita do request.
- `userIds` de cada documento em ordem crescente.
- chaves de cargas e coocorrência em ordem crescente apenas para serialização e hash; os cálculos usam números, não ordem de objeto.

O oracle é um loader paginado que seleciona todas as linhas relevantes, aplica as regras atuais e produz `preservedSet`, `docAssignedUsers`, `preservedByUser` e `coOccurrence`. Ele existe somente em testes/benchmark e precisa usar a mesma normalização.

Para cada cenário e 100 seeds fixas, a saída nova deve ser igual à do oracle como array ordenado de `{ document_id, user_id }`, além de igualdade de `preservedCount`, `preservedByUser`, `eligibleCount`, preview por participante e `batchData.filters.seed`. A comparação de conjuntos apenas não basta: a sequência consome o PRNG e faz parte da reprodução prévia → execução.

A introdução da ordenação canônica pode mapear uma seed antiga para pares diferentes daqueles produzidos por uma ordem arbitrária do banco. Isso não viola um contrato existente, porque essa ordem nunca foi definida; a partir do rollout, preview e execução passam a compartilhar a ordem canônica e a garantia fica mais forte.

## Alternativas avaliadas

### Apenas filtrar por tipo e status

É uma correção necessária e barata, pois o código já descarta essas linhas. Contudo, ainda devolve até 150.000 linhas na escala densa e continua sujeito ao teto de resposta se não houver paginação. Deve existir no oracle paginado, mas não é a solução final recomendada.

### Paginar todas as linhas preservadas

Preserva a semântica e elimina truncamento, sendo o fallback operacional mais seguro. Mantém payload, serialização e agregação O(A) no Node, onde A é o número de assignments preservados. Serve como referência e rota temporária de rollback, não como arquitetura principal.

### Descartar assignments antigas

Foi rejeitado. Uma janela temporal reduz `preservedByUser` e coocorrência, altera FR-014/FR-018 e muda resultados mesmo quando documentos e parâmetros são iguais. Não há regra de produto que diga quando uma colaboração deixa de contar.

### Reutilizar `lottery_doc_stats`

Contagens por documento não recuperam quais usuários ocupam as vagas nem os pares necessários à coocorrência. Estender a view com arrays de usuários ajudaria apenas a parte por documento e ainda deixaria carga e coocorrência globais; uma RPC parametrizada expressa melhor modo, tipo, participantes e documentos candidatos.

### Manter agregados incrementais em tabela

Uma tabela de cargas e pares reduziria o custo de leitura, mas adicionaria sincronização em INSERT, UPDATE, DELETE, replace atômico, unificação de membros e remoção de projeto. Sem benchmark que mostre a RPC insuficiente, esse estado derivado persistido cria mais risco de drift do que benefício.

### Mover toda a distribuição para Postgres

Foi rejeitado nesta etapa porque duplicaria `distributeDocs`, PRNG mulberry32, pesos, capacidades e desempates em PL/pgSQL. O ganho esperado está em reduzir I/O e agregação de histórico; o núcleo puro já é testado e não precisa mudar de linguagem.

## Solução recomendada

### Interface no TypeScript

```ts
interface LotteryAssignmentState {
  preservedCount: number;
  documentUsers: Array<{
    documentId: string;
    userIds: string[];
  }>;
  participantLoads: Record<string, number>;
  coOccurrence: Record<string, Record<string, number>>;
}
```

O contrato de produção aceita no máximo 5.000 IDs distintos em `p_document_ids` e 30 IDs distintos em `p_participant_ids`, rejeitando array nulo, duplicado ou acima do teto antes de consultar o estado. O resultado aceita no máximo 150.000 elementos somados em `documentUsers`, 150.000 células não zero em `coOccurrence` e 15 MiB UTF-8 após serialização canônica. Ultrapassar qualquer limite retorna `LOTTERY_STATE_LIMIT_EXCEEDED`; a função nunca trunca arrays, contadores ou pares. Esses tetos cobrem o cenário denso publicado e tornam explícita a fronteira na qual o produto precisa paginar ou rever a arquitetura.

O loader paginado permanece apenas como oracle e rollback temporário: cada página tem teto fixo e uma contagem independente prova que todas foram lidas. O caminho RPC não mascara estouro com paginação implícita, pois combinar páginas obtidas de snapshots diferentes quebraria preview e execução; se o volume real exceder o contrato acima, a ação falha antes de distribuir e exige uma solução com snapshot transacional explícito.

A Server Action executa nesta ordem:

1. Busca `lottery_doc_stats`, projeto, lotes e membros como hoje.
2. Aplica o gate de comparação e `filterEligibleDocs` sobre stats ordenadas por `id`.
3. Chama a RPC com `project_id`, `assignmentType`, modo, `participantIds` e os IDs filtrados.
4. Reconstrói `preservedSet`, `docAssignedCount` e `docAssignedUsers` somente para documentos candidatos a partir de `documentUsers`.
5. Usa `participantLoads` para carga/capacidade e a matriz esparsa para `distributeDocs`.
6. Mantém subset, seed, preview, batch e RPC de persistência atuais.

Os passos 1 e 3 são sequenciais por dependência: a RPC precisa da lista filtrada de documentos para não devolver usuários por documento que a distribuição nunca consultará. Lotes e membros, que não dependem dessa lista, continuam paralelizáveis.

### Interface SQL

A função sugerida é `get_lottery_assignment_state(p_project_id uuid, p_type text, p_mode text, p_participant_ids uuid[], p_document_ids uuid[])`, `SECURITY INVOKER`, `STABLE`, com objetos `public.` qualificados. Ela rejeita tipo/modo fora das allowlists e deixa RLS das tabelas base governar o acesso.

Um CTE materializado `preserved` seleciona somente `project_id = p_project_id`, `type = p_type` e status permitidos pelo modo. A partir dele, a função produz:

- `preservedCount`: `count(*)` de todo o CTE.
- `documentUsers`: `array_agg(user_id ORDER BY user_id)` agrupado por `document_id`, restrito a `p_document_ids`.
- `participantLoads`: `count(*)` por `user_id`, restrito a `p_participant_ids`, mas calculado em todo o projeto.
- `coOccurrence`: self-join por `document_id`, com o primeiro usuário restrito aos participantes e o segundo restrito ao conjunto realmente consultável por `distributeDocs` — participantes mais usuários preservados nos documentos candidatos —, agrupado pelo par e sem auto-par. A contagem continua percorrendo todo o histórico preservado, inclusive documentos fora dos candidatos; restringe-se apenas quais células materiais são devolvidas, nunca quais colaborações contribuem para elas.

O conjunto de parceiros relevantes é derivado dentro da função a partir de `p_participant_ids` e dos mesmos `documentUsers`; assim, inclui ex-membro ou participante desligado quando ele ocupa vaga em um documento candidato. O JSON de saída deve ordenar arrays e chaves canonicamente. Documentos sem preservadas podem ser omitidos; o cliente interpreta ausência como lista vazia. Participantes sem carga ou par também podem ser omitidos e recebem zero. Antes de retornar, a função valida contagens estruturais e `octet_length(result::text)` contra os tetos publicados e falha fechado se qualquer um for excedido.

### Índice

A migration deve adicionar e medir:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assignments_lottery_state
  ON assignments(project_id, type, status, document_id, user_id);
```

Migrations transacionais do Supabase podem não aceitar `CONCURRENTLY`; nesse caso, o plano de aplicação precisa separar a criação do índice ou usar criação normal em janela controlada, conforme o tamanho real da tabela. Não se remove nenhum índice existente até `pg_stat_user_indexes` demonstrar redundância em produção.

O benchmark deve comparar também a ordem alternativa `(project_id, type, status, user_id, document_id)`. A decisão final fica com o plano que atende simultaneamente o agrupamento por documento e as cargas por usuário com menos buffers; este documento não alega um plano não medido.

## Testes de implementação

### Testes SQL

- Fixtures pequenas com resultado manual para append e replace, dois tipos, três status, usuário fora do pool e documento fora dos candidatos.
- RLS: coordenador e membro autorizado leem somente seu projeto; usuário externo e anon não recebem estado; master segue o contrato vigente.
- Arrays e JSON saem em ordem canônica e não duplicam usuários.
- 0, 1 e 30 usuários no mesmo documento cobrem self-join e ausência de auto-par.
- Inputs no limite e uma unidade acima provam os tetos de documentos e participantes; fixtures excedendo elementos, células ou 15 MiB provam falha fechada sem prefixo parcial.
- Usuário fora do pool, mas presente em documento candidato, aparece como parceiro relevante e carrega sua coocorrência de todo o histórico; usuário histórico que nunca pode ser consultado não ocupa payload.
- O índice aparece no plano dos cenários típico e denso quando o planner o considerar vantajoso; não se força índice em teste unitário.

### Testes TypeScript

- Adapter da RPC reconstrói exatamente `preservedSet`, `docAssignedCount`, `docAssignedUsers`, `preservedByUser` e `coOccurrence`, além de preservar `preservedCount`.
- `computeLottery` não consulta `assignments` cru no caminho novo.
- As 100 seeds por cenário produzem igualdade exata com o oracle paginado.
- Testes existentes de SC-005, SC-006, SC-007, pesos, capacidade, anti-duplicidade e FR-014 continuam passando sem alterar expectativas.
- Erro ou payload inválido da RPC falha fechado e não chama `smart_randomize_replace`.

### Benchmark e integração

- O gerador e o runner ficam versionados fora da suíte rápida, com comando explícito e manifesto JSON de resultados.
- Preview e execução sobre o mesmo snapshot e seed geram contagens e pares idênticos.
- Uma execução replace confirma que a RPC leu o estado anterior, enquanto a persistência transacional remove apenas pendentes e grava exatamente os pares calculados.

## Rollout e fallback operacional

O rollout pode manter, por no máximo 7 dias corridos ou 50 execuções reais — o que ocorrer primeiro —, um seletor operacional `LOTTERY_STATE_SOURCE=rpc|legacy_paginated`. A ativação registra uma deadline absoluta igual a `enabled_at + 7 dias`, que não pode ser estendida por falta de uso. O caminho legado precisa ser paginado e filtrado por tipo/status; o fetch atual sem paginação não é um rollback aceitável.

Na primeira etapa, previews podem executar ambos os loaders, devolver somente o resultado legado e registrar hash/contadores da comparação sem IDs em logs. Divergência falha o gate e impede habilitar a RPC para escrita. Depois de 100% de equivalência no conjunto observado e atendimento dos limiares, a RPC vira default. Se a janela expirar sem evidência suficiente, o rollout volta ao legado paginado e reabre a decisão; não mantém os dois loaders indefinidamente.

Não existe fallback automático em erro de RPC. Falhar silenciosamente para outro snapshot poderia fazer preview e execução usarem estados distintos. O operador muda a flag e redeploya de forma explícita; a ação atual falha com mensagem ao coordenador.

Ao final da janela, remover a flag, o shadow oracle de produção e o caminho que não foi promovido. Se os gates passaram, permanece somente a RPC; se a decisão foi reaberta, permanece somente o legado paginado até a nova arquitetura. O harness de teste/benchmark continua versionado. Manter dois loaders de produção criaria drift sem necessidade.

## Gatilho para iniciar a implementação

A implementação deve ser priorizada quando ocorrer ao menos um destes eventos mensuráveis:

- qualquer projeto ultrapassar o teto de linhas por resposta configurado no PostgREST para assignments relevantes;
- projeto ativo alcançar aproximadamente 5.000 documentos ou 30 membros;
- o tipo/modo medido alcançar 10.000 assignments preservadas;
- p95 de `previewLottery` ou `smartRandomize` ultrapassar 1,5 segundo em 30 execuções aquecidas;
- houver relato reproduzível de truncamento, timeout, memória excessiva ou lentidão na prévia/execução.

O primeiro evento é de correção e não deve esperar queixa de performance. Os demais disparam o benchmark; só depois dos números se abre a implementação da RPC.

## Critérios de aceite

- Nenhuma query de produção busca assignments preservadas sem filtro e sem teto verificável.
- Inputs, elementos agregados, células de coocorrência e payload serializado respeitam tetos explícitos; qualquer excesso falha sem truncar.
- O resultado da RPC coincide com o oracle em 100 seeds de cada cenário e em 100% dos pares, contadores e sequência.
- Coocorrência continua considerando todo o histórico preservado e usuários fora do pool.
- O caminho típico e o denso atendem aos limiares publicados ou a decisão é reaberta com resultados anexos.
- RLS é exercida diretamente sobre a função e não depende apenas de `.eq("project_id", ...)` no cliente.
- Preview e execução continuam idênticos para dados/configuração/seed iguais.
- O fallback é manual e paginado; após a janela, o seletor e o caminho não promovido são removidos, sem dois loaders permanentes.
