# Proposta cirúrgica: rodadas nomeadas como único modelo de codificação

Status: decisão técnica e runbook para implementação futura, sem migration aplicada e sem alteração de dados remotos.

Referência: `Refs #223`.

## Decisão

Rodadas nomeadas passam a ser o único mecanismo que define o ciclo de codificação. `schema_version_major/minor/patch`, `pydantic_hash`, `answer_field_hashes` e `schema_change_log` permanecem como histórico do formulário, mas deixam de decidir se um documento está pendente na aba Codificar.

O corte é cirúrgico: esta proposta altera a persistência de `round_id`, a fila de Codificação, a gestão de rodadas e a criação de projetos. Não altera a aba Comparar, `compare-version.ts`, `compare-sync.ts`, `auto-comparison.ts`, os filtros de versão ou as regras de encerramento de comparação.

O código atual confirma a duplicidade que será removida:

- `frontend/src/lib/rounds.ts` bifurca classificação, rótulo e filtro entre `manual` e `schema_version`.
- `frontend/src/components/config/RoundsConfig.tsx` oferece duas estratégias e só exibe a gestão de rodadas nomeadas no ramo manual.
- `frontend/src/actions/rounds.ts::setRoundStrategy()` ainda permite voltar a `schema_version`; deixar essa mutação aberta entre o backfill e o frontend final faria o save humano antigo tentar gravar `round_id=NULL` contra a nova constraint.
- `frontend/src/actions/responses.ts` persiste `current_round_id` apenas quando `round_strategy === "manual"`.
- `analyze/code/page.tsx` lê todas as respostas humanas do pesquisador sem filtrar `is_latest`; após unificação de membros podem coexistir rows superseded, e o `Map` sem `ORDER BY` pode deixar uma delas decidir a rodada exibida. `fetchSaveContext()` já reconhece esse caso e filtra `is_latest=true`.
- `backend/services/llm_runner.py::_build_llm_response_row()` já persiste semver, mas `_RunMetadata` e o payload não contêm `round_id`.
- Os filtros LLM ainda são globais: `_filter_docs()` e `frontend/src/actions/llm.ts::getEligibleDocCount()` contam qualquer resposta `is_latest`, enquanto `llm/configure/page.tsx` e `getDocumentsForSelection()` repetem a mesma leitura para o resumo e o seletor. Se apenas um desses caminhos passar a filtrar por rodada, a UI exibirá contagens contraditórias e poderá enviar ao backend um conjunto diferente do anunciado.
- `frontend/src/actions/projects.ts::createProject()` cria projeto e membership em operações separadas e não cria rodada inicial.
- As FKs atuais usam `ON DELETE SET NULL`, embora a aplicação precise tratar projeto e resposta sem rodada como estados inválidos após a consolidação.

Há ainda uma correção factual em relação ao texto histórico da issue: `DEFAULT_COMPARE_FILTERS.version` é `"all"`, mas `compareDefaultsForMode()` aplica hoje `COMPARE_DEFAULT_VERSION`, atualmente `"latest_major"`, na página e nos fluxos vivos de automação. Isso não muda o escopo: a Comparação permanece exatamente como está e deve ser revalidada apenas para provar ausência de regressão.

## Modelo de dados final

As invariantes finais são:

1. Todo projeto tem exatamente uma `current_round_id` não nula.
2. Toda resposta humana ou LLM, completa ou parcial, tem uma `round_id` não nula.
3. A rodada atual pertence ao próprio projeto.
4. A rodada de uma resposta pertence ao mesmo projeto da resposta.
5. Uma rodada atual ou referenciada por respostas não pode ser excluída.
6. `round_strategy` deixa de existir; não há valor default ou fallback que recrie a estratégia antiga.

O banco deve tornar essas invariantes estruturais, não depender apenas dos checks de Server Actions:

```sql
ALTER TABLE rounds
  ADD CONSTRAINT rounds_project_id_id_key UNIQUE (project_id, id);

-- Forma conceitual; os nomes e a ordem exatos entram na migration.
ALTER TABLE projects
  ALTER COLUMN current_round_id SET NOT NULL,
  ADD CONSTRAINT projects_current_round_same_project_fk
    FOREIGN KEY (id, current_round_id)
    REFERENCES rounds(project_id, id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE responses
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN round_id SET NOT NULL,
  ADD CONSTRAINT responses_round_same_project_fk
    FOREIGN KEY (project_id, round_id)
    REFERENCES rounds(project_id, id)
    DEFERRABLE INITIALLY DEFERRED;
```

As FKs simples atuais devem ser substituídas, não mantidas em paralelo. A ação referencial deixa de ser `ON DELETE SET NULL`; [`NO ACTION` permite adiar a validação](https://www.postgresql.org/docs/current/ddl-constraints.html), ao contrário de `RESTRICT`. Assim, a FK diferível permite excluir um projeto inteiro com seus filhos em cascata, mas impede que a exclusão isolada de uma rodada produza projeto ou resposta sem rodada ao fim da transação.

`responses.project_id` também se torna `NOT NULL`, porque uma FK composta com `MATCH SIMPLE` não valida a relação quando uma das colunas é nula. O preflight deve bloquear qualquer linha órfã antes dessa alteração.

`deleteRound()` precisa traduzir essa restrição para mensagens úteis: rodada atual não pode ser excluída; rodada com respostas não pode ser excluída; rodada não atual e sem uso pode ser removida. `setCurrentRound()` passa a exigir `roundId: string`, sem aceitar `null`.

## Política de migração de dados

Não é seguro atribuir toda resposta `round_id IS NULL` à rodada corrente de um projeto manual com várias rodadas. O banco não audita as trocas históricas de `current_round_id`; timestamps de resposta e `rounds.created_at` não provam qual rodada estava ativa. Nesses casos, a migration deve parar e exigir uma decisão explícita, em vez de inferir pela data ou pelo nome.

Classificação por projeto:

| Estado anterior | Rodada de destino | `current_round_id` após migration |
| --- | --- | --- |
| `round_strategy='schema_version'` | criar uma nova `Rodada inicial`; associar a ela apenas respostas com `round_id IS NULL` | a nova `Rodada inicial` |
| manual, zero rodadas | criar `Rodada inicial`; associar os `NULL` a ela | a nova `Rodada inicial` |
| manual, uma rodada | reutilizar a única rodada para os `NULL` | preservar a atual válida ou usar a única rodada se estava nula |
| manual, várias rodadas, nenhuma resposta `NULL`, atual válida | não alterar associações | preservar a atual |
| manual, várias rodadas e alguma resposta `NULL` | ambíguo; bloquear até existir mapa explícito | preservar a atual válida |
| manual, várias rodadas e atual nula/inválida | ambíguo; bloquear até o coordenador escolher | valor escolhido explicitamente |

Respostas com `round_id` já preenchido nunca são reatribuídas automaticamente. A consolidação intencional da issue vale para o histórico que hoje depende de semver e está sem rodada; não autoriza apagar associações manuais já existentes.

Para projetos ambíguos, um override por projeto só é suficiente quando o coordenador confirma que todas as respostas sem rodada pertencem à mesma rodada. Se houve troca de rodada ao longo do período, o input precisa mapear `response_id → round_id`. A migration valida que cada rodada escolhida pertence ao projeto da resposta.

O rótulo `Rodada inicial` é conteúdo editável, não identidade técnica. Antes de criar a rodada de bootstrap, o preflight deve detectar colisão de label em projetos `schema_version`. A execução bloqueia e pede renomeação ou uma rodada de destino explícita; não escolhe uma rodada existente só porque o texto coincide.

## Ordem segura de entrega

A ordem segura é release de compatibilidade → migration/backfill → frontend simplificado → cleanup. A sequência “migration → backend” registrada numa parte da issue abre duas janelas reais: uma nova resposta LLM ainda seria inserida com `round_id=NULL`, e `createProject()` continuaria tentando inserir um projeto sem rodada depois que `current_round_id` se tornasse obrigatório.

### 1. Release de compatibilidade primeiro

Esta etapa tem uma dependência interna que não pode ser tratada como deploy atômico: primeiro entra uma migration exclusivamente aditiva que torna a FK atual diferível e cria a RPC; só depois pode ser implantado código que chama essa RPC. Publicar `createProject()` antes de `create_project_with_initial_round(...)` existir produziria falha imediata na criação de projetos.

#### 1a. Schema de compatibilidade

Uma migration pequena torna a FK atual `projects.current_round_id → rounds.id` `DEFERRABLE INITIALLY DEFERRED` e cria a RPC `create_project_with_initial_round(...)`. A função pregera os UUIDs do projeto e da rodada, insere o projeto já com `current_round_id` apontando para o UUID reservado, insere `Rodada inicial` e a membership de coordenador na mesma transação. A FK diferida só é checada no commit, quando a rodada já existe. Depois das constraints compostas finais, a mesma ordem continua válida.

A RPC usa `SECURITY DEFINER`, `SET search_path=''`, valida `clerk_uid()`, revoga `EXECUTE` de `PUBLIC`/`anon`, concede apenas ao papel autenticado usado pelo app e retorna somente o `project_id`. `created_by`, o `user_id` da membership, o papel `coordenador` e o label inicial não são argumentos: a função os deriva do caller e de constantes, tornando impossível pedir criação em nome de outra pessoa. Um teste SQL deve provar tanto a atomicidade quanto essa fronteira de autorização.

#### 1b. Persistência e mutações dual-compatible

Adicionar `current_round_id` ao select do projeto e à `_RunMetadata`; `_build_llm_response_row()` grava `round_id=run.current_round_id`. O tipo é inicialmente `str | None`, porque projetos `schema_version` ainda podem ter `current_round_id=NULL` antes da migration. Isso é compatível com o schema atual e não muda o comportamento dos projetos antigos.

Nesta subetapa, `_filter_docs()` e as contagens do frontend ainda preservam a semântica global. Separar a persistência da mudança comportamental permite implantar e validar o backend que grava `round_id` sem criar uma janela em que o conjunto executado difere do anunciado pela UI antiga.

`frontend/src/actions/projects.ts::createProject()` passa a chamar a RPC depois do passo 1a. Implantar primeiro o backend que persiste `round_id` e depois esse frontend de compatibilidade. O restante do frontend continua bifurcando por estratégia; projeto novo nasce com `round_strategy='manual'`, comportamento que o código atual já suporta.

Na mesma release, congelar `setRoundStrategy()` e tornar o seletor apenas informativo: projetos existentes conservam a estratégia até a migration, mas nenhum caller pode alterná-la durante a janela. Permitir apenas a transição manual pela action também não basta, porque um projeto `schema_version` pode ainda não ter rodada atual; a mudança segura é o backfill transacional.

`setCurrentRound()` passa a rejeitar `null` em runtime, e `deleteRound()` consulta e bloqueia rodada atual ou já referenciada antes de executar o delete, com mensagens específicas. Esses guards fecham os caminhos normais durante a compatibilidade; as constraints compostas do passo 2 continuam sendo a garantia estrutural contra chamada direta e corrida.

Testes de backend devem provar que respostas completas e parciais carregam `round_id` e que todas as rows de uma run usam o snapshot capturado no início.

#### 1c. Ativação coordenada dos filtros LLM

O mesmo contexto de rodada entra em `_filter_docs()`: `pending` e `max_responses` passam a contar respostas LLM `is_latest=true` da rodada atual, não respostas de qualquer rodada histórica. Durante a compatibilidade, porém, o filtro por rodada só pode ser ativado quando `round_strategy='manual'` **e** `current_round_id IS NOT NULL`; projetos `schema_version` preservam a leitura global antiga até o backfill. Testar apenas `current_round_id` é incorreto porque um projeto que voltou de `manual` para `schema_version` pode conservar um ponteiro stale por design.

O frontend deve aplicar o mesmo gate dual-compatible em todos os quatro consumidores da contagem: `getEligibleDocCount()`, o resumo inicial de `frontend/src/app/(app)/projects/[id]/llm/configure/page.tsx`, `getDocumentsForSelection()` e a copy/badges do `RunCard`/`DocumentSelector`. Depois do backfill, os textos passam a dizer explicitamente “nesta rodada”. Alterar apenas a action dinâmica deixaria o resumo “já possuem resposta LLM” e o atalho “Sem resposta LLM” calculados sobre todo o histórico, em desacordo com o conjunto executado pelo backend.

Essa mudança não toca a Comparação; apenas impede que uma resposta LLM de uma rodada anterior faça o documento parecer já processado na rodada atual.

Backend e frontend não podem ser ativados em sequência com tráfego LLM aberto. Bloquear temporariamente `/api/llm/run` e `/api/llm/run-field`, drenar runs em andamento, implantar os dois lados, executar smoke comparando o conjunto/contagem de `pending` e `max_responses` e só então reabrir. Uma feature flag compartilhada e default-off seria alternativa válida, mas não é necessária se a manutenção coordenada for registrada e testada.

Testes devem provar que `pending` ignora respostas de rodadas anteriores, que `max_responses` usa apenas a rodada corrente e que os quatro consumidores do frontend anunciam o mesmo conjunto do backend. O backfill só começa quando os três caminhos de escrita futuros — resposta LLM, resposta humana e criação de projeto — e os filtros coordenados já são compatíveis com rodadas nomeadas.

### 2. Migration backward-compatible e transacional

A migration roda em uma única transação e cria uma tabela temporária de mapeamento `project_id → target_round_id`, preenchida conforme a matriz acima e pelos overrides aprovados. Isso mantém a identidade independente do label e permite usar os UUIDs produzidos no mesmo backfill. Overrides não são decisões digitadas durante a janela: o input exato (`project_id → current_round_id` e, quando necessário, `response_id → round_id`) deve estar materializado e revisado antes da execução; a transação rejeita chaves desconhecidas, cobertura incompleta e qualquer vínculo cross-project.

Antes de abrir a transação, colocar os caminhos de escrita em manutenção, impedir novas chamadas a `/api/llm/run` e `/api/llm/run-field`, resolver runs stale e esperar `llm_runs.status='running'` chegar a zero. Isso é obrigatório: uma run já em processamento pode ter capturado `current_round_id=NULL` antes do backfill e tentar inserir depois do `SET NOT NULL`; um lock em `responses` apenas adia esse insert e o faria falhar após o commit. Pelo mesmo motivo, deve-se drenar saves humanos já iniciados, não apenas confiar no lock.

Ordem interna:

1. Definir `lock_timeout` e adquirir, sempre na mesma ordem, `LOCK TABLE projects`, `rounds`, `responses` e `llm_runs IN SHARE ROW EXCLUSIVE MODE`; [esse modo conflita com o `ROW EXCLUSIVE` de `INSERT`/`UPDATE`/`DELETE`](https://www.postgresql.org/docs/current/explicit-locking.html). Repetir então os checks de ambiguidade e de runs ativas. Os `ALTER TABLE` posteriores elevarão o lock para `ACCESS EXCLUSIVE`, que é o default documentado para as formas sem exceção explícita.
2. Capturar, no mesmo snapshot bloqueado, `response_id, old_round_id` e `project_id, old_current_round_id, old_round_strategy` em artefato operacional protegido ou tabela privada com política de retenção definida. Um export feito antes de drenar e bloquear escritas não é rollback consistente.
3. Criar as rodadas de bootstrap necessárias e preencher o mapa temporário.
4. Validar cada override e abortar se projeto, resposta ou rodada não coincidirem.
5. Atualizar somente `responses.round_id IS NULL`, cobrindo humanos e LLM, inclusive respostas `is_latest=false` e `is_partial=true`.
6. Atualizar `projects.current_round_id` conforme a matriz, definir `round_strategy='manual'` para todos os projetos, trocar o default para `'manual'` e substituir o `CHECK` de duas estratégias por um `CHECK (round_strategy = 'manual')` transitório. Manter o default antigo `'schema_version'` sob o novo `CHECK` faria qualquer insert que omitisse a coluna nascer inválido. O contrato manual-only impede que UI stale ou chamada PostgREST direta reintroduza o estado incompatível antes do drop da coluna.
7. Validar que não restou projeto/resposta sem rodada nem vínculo cross-project.
8. Substituir as FKs simples pelas compostas e aplicar `NOT NULL`.
9. Commitar somente se todas as contagens e invariantes baterem; reabrir as escritas apenas depois dos checks pós-migration.

O código em produção já entende `round_strategy='manual'`; portanto, assim que a transação termina, o frontend antigo passa a gravar `current_round_id` nas respostas humanas. O backend já terá sido preparado no passo anterior, fechando também o caminho LLM.

### 3. Aplicação simplificada

Mudanças previstas:

- `backend/services/llm_runner.py`: remover `round_strategy` do select/gate transitório; tratar `current_round_id` como `str` obrigatório no snapshot da run, falhando antes de chamar o provider se o projeto violar a invariante; `_filter_docs()` sempre filtra a resposta LLM pela rodada capturada. Essa versão precisa estar implantada antes do cleanup que remove a coluna.
- `frontend/src/lib/rounds.ts`: `RoundContext` mantém apenas `currentRoundId` e `rounds`; `classifyDocStatus()`, `responseRoundLabel()`, `getCurrentRoundDescriptor()` e `resolveRoundFilter()` usam somente `round_id`. Remover `SchemaVersion`, `versionLabel()`, `versionEquals()` e `compareVersionLabels()` deste módulo quando não houver outro caller.
- `frontend/src/lib/types.ts`: remover `RoundStrategy` e `Project.round_strategy`; manter `Round`, `Project.current_round_id` agora não nulo no shape final.
- `frontend/src/actions/responses.ts`: retirar `round_strategy` do select e sempre persistir `project.current_round_id`. Ausência de rodada é erro explícito, não fallback para `null`.
- `frontend/src/app/(app)/projects/[id]/analyze/code/page.tsx`: retirar semver do `RoundContext`, remover `previousVersions`, filtrar rodadas anteriores por `response.round_id` e adicionar `.eq("is_latest", true)` à query humana, alinhando-a ao save e impedindo que uma row superseded determine a rodada. A query deve continuar trazendo semver apenas se outro comportamento da página realmente o usa; para rodadas, ele deixa de ser necessário.
- `frontend/src/components/coding/CodingPage.tsx` e `CodingHeader.tsx`: remover `RoundFilterData.strategy` e `previousVersions`; o dropdown lista “Atual”, “Todas” e as rodadas nomeadas não atuais.
- `frontend/src/components/config/RoundsConfig.tsx`: remover o `RadioGroup` e sempre exibir a lista de rodadas. `createRound()` deixa de receber `setAsCurrent` implicitamente; tornar atual permanece uma ação explícita.
- `frontend/src/actions/rounds.ts`: remover `setRoundStrategy()`; `setCurrentRound()` não aceita `null`; `deleteRound()` trata os erros de referência.
- `frontend/src/app/(app)/projects/[id]/config/rounds/page.tsx`: não buscar nem passar estratégia ou versão.
- `frontend/src/actions/llm.ts`, `frontend/src/app/(app)/projects/[id]/llm/configure/page.tsx`, `RunCard` e `DocumentSelector`: remover o gate transitório por estratégia, manter o filtro por `current_round_id` e rotular as contagens como pertencentes à rodada atual.

URLs `?round=<uuid>` continuam estáveis. UUID desconhecido continua normalizado para `current`, mas o caso “Rodada removida” deixa de ser estado persistível porque rodadas referenciadas não podem ser excluídas.

### 4. Projeto novo nasce válido

`createProject()` precisa criar projeto, membership de coordenador, `Rodada inicial` e `current_round_id` na mesma transação. O fluxo atual já pode deixar um projeto órfão se a segunda operação falhar; acrescentar uma terceira chamada sequencial agravaria o estado intermediário.

A solução proposta é a RPC `create_project_with_initial_round(...)` implantada já na release de compatibilidade, com `SECURITY DEFINER`, `SET search_path=''`, validação de `clerk_uid()`, grants mínimos e retorno do `project_id`. A função insere os quatro vínculos e só retorna depois do commit. O default de `round_strategy` ainda pode ser `manual` durante a janela de compatibilidade e desaparece na limpeza.

### 5. Cleanup posterior

Somente depois de backend, frontend e scripts não referenciarem `round_strategy`, uma migration separada remove a coluna e seu `CHECK`. Antes desse drop, um `rg` limitado a `frontend/src`, `frontend/scripts` e `backend` deve retornar zero referências produtivas ao símbolo; migrations históricas naturalmente continuam contendo o nome. Fixtures e testes também precisam ser atualizados.

Não remover semver de `projects`, `responses` ou `schema_change_log`. Não renomear `round_id` nem reutilizar a coluna como versão.

## Preflight

Executar em modo somente leitura e guardar o resultado junto do checklist da mudança. As consultas abaixo são o núcleo; a migration deve repetir as condições que importam para evitar corrida entre preflight e commit.

```sql
-- 1. Current round ausente ou de outro projeto.
SELECT p.id, p.name, p.round_strategy, p.current_round_id
FROM projects AS p
LEFT JOIN rounds AS r
  ON r.id = p.current_round_id
 AND r.project_id = p.id
WHERE p.current_round_id IS NOT NULL
  AND r.id IS NULL;

-- 2. Resposta aponta para rodada de outro projeto.
SELECT resp.id, resp.project_id, resp.round_id
FROM responses AS resp
LEFT JOIN rounds AS r
  ON r.id = resp.round_id
 AND r.project_id = resp.project_id
WHERE resp.round_id IS NOT NULL
  AND r.id IS NULL;

-- 2a. Resposta sem projeto não pode receber uma rodada de forma segura.
SELECT id, document_id, respondent_type
FROM responses
WHERE project_id IS NULL;

-- 3. Inventário que identifica projetos manuais ambíguos.
WITH round_counts AS (
  SELECT project_id, count(*) AS round_count
  FROM rounds
  GROUP BY project_id
), null_response_counts AS (
  SELECT project_id, count(*) AS null_response_count
  FROM responses
  WHERE round_id IS NULL
  GROUP BY project_id
)
SELECT p.id, p.name, p.current_round_id,
       coalesce(rc.round_count, 0) AS round_count,
       coalesce(nc.null_response_count, 0) AS null_response_count
FROM projects AS p
LEFT JOIN round_counts AS rc ON rc.project_id = p.id
LEFT JOIN null_response_counts AS nc ON nc.project_id = p.id
WHERE p.round_strategy = 'manual'
  AND (
    (coalesce(rc.round_count, 0) > 1 AND coalesce(nc.null_response_count, 0) > 0)
    OR (coalesce(rc.round_count, 0) > 1 AND p.current_round_id IS NULL)
  )
ORDER BY p.name;

-- 4. Colisão do label reservado em projetos schema_version.
SELECT p.id, p.name, r.id AS existing_round_id, r.label
FROM projects AS p
JOIN rounds AS r ON r.project_id = p.id
WHERE p.round_strategy = 'schema_version'
  AND lower(btrim(r.label)) = lower('Rodada inicial');
```

Também registrar antes da migration: total de projetos; total de respostas; respostas por `respondent_type`, `is_latest` e `is_partial`; quantidade de `round_id IS NULL`; projetos por estratégia; rodadas por projeto; e distribuição de respostas já associadas a rodadas. A migration não deve alterar a contagem de respostas.

Condições de no-go:

- qualquer vínculo cross-project;
- qualquer resposta sem `project_id`;
- projeto manual ambíguo sem override aprovado;
- collision de `Rodada inicial` sem decisão explícita;
- release de compatibilidade de backend e criação de projeto ainda não implantada;
- ativação coordenada dos filtros LLM ainda não concluída e validada nos dois lados;
- mutação de `round_strategy` ainda disponível na action/UI de compatibilidade;
- caminhos de escrita ainda abertos, save humano em andamento ou qualquer `llm_runs.status='running'` não explicado;
- testes do reset local da base ou backup lógico falhando;
- contagens mudando entre o preflight final e a janela de execução sem explicação.

## Verificação pós-migration

Antes do frontend simplificado:

```sql
SELECT count(*) FROM projects WHERE current_round_id IS NULL;
SELECT count(*) FROM responses WHERE round_id IS NULL;
SELECT count(*) FROM projects WHERE round_strategy <> 'manual';

SELECT count(*)
FROM projects AS p
LEFT JOIN rounds AS r
  ON r.id = p.current_round_id
 AND r.project_id = p.id
WHERE r.id IS NULL;

SELECT count(*)
FROM responses AS resp
LEFT JOIN rounds AS r
  ON r.id = resp.round_id
 AND r.project_id = resp.project_id
WHERE r.id IS NULL;
```

Os cinco resultados devem ser zero. Repetir as contagens prévias e confirmar que o total de projetos e respostas não mudou; apenas `round_id`, `current_round_id` e `round_strategy` devem ter sido preenchidos/ajustados.

Smokes funcionais:

1. Projeto migrado abre Configurações → Rodadas com uma rodada atual.
2. Codificação antiga associada à rodada inicial sai dos pendentes da rodada atual conforme a decisão da issue.
3. Criar e ativar nova rodada faz codificações anteriores aparecerem como anteriores e documentos voltarem a pendentes.
4. Save humano e run LLM novos recebem a rodada atual.
5. “Apenas pendentes”, “Até N respostas”, o resumo inicial e “Sem resposta LLM” do seletor consideram a rodada atual; as quatro contagens do frontend coincidem com o conjunto executado pelo backend.
6. Aba Comparar conserva filtros, resultados e encerramento; não há mudança de query por `round_id`.
7. Exclusão de rodada atual/usada falha com mensagem clara; exclusão de rodada vazia e não atual funciona.

## Rollback

Antes da migration de cleanup, o rollback preferencial não volta ao baseline anterior à compatibilidade: mantém o banco migrado e reimplanta a release dual-compatible do passo 1. Ela ainda entende `round_strategy='manual'`, grava `round_id` no backend e cria projetos pela RPC, portanto é compatível com os `NOT NULL` finais. O artefato/imagem exato dessa release deve ser registrado como checkpoint antes do backfill.

Não é seguro reimplantar o backend anterior ao passo 1 enquanto `responses.round_id` permanecer `NOT NULL`: aquele backend insere respostas LLM sem `round_id`. Também não é seguro reimplantar o `createProject()` antigo enquanto `projects.current_round_id` for `NOT NULL`, pois ele cria o projeto sem rodada; o frontend antigo em estratégia `schema_version` igualmente grava resposta humana com `round_id=NULL`.

Se for indispensável reativar o comportamento por semver, executar um roll-forward explícito antes de reimplantar o baseline: restaurar a coluna/`CHECK` e os valores de `round_strategy` a partir do snapshot, retirar os dois `NOT NULL` que o código antigo viola e restaurar as ações referenciais esperadas por `deleteRound()` (`ON DELETE SET NULL`) ou manter essa ação desabilitada. Só então o código pré-compatibilidade pode voltar. Não apagar as rodadas de bootstrap nem zerar `round_id` já preenchido; os dados adicionais são compatíveis com o modelo antigo.

O backfill não é automaticamente reversível: depois de associar respostas antes sem rodada, não há como distinguir “era NULL” de “já tinha esta rodada” sem o snapshot. Guardar um artefato de rollback com `response_id, old_round_id`, `project_id, old_current_round_id, old_round_strategy` antes da atualização. Esse artefato contém identificadores e deve ficar em armazenamento operacional protegido, não no repositório.

Depois do drop de `round_strategy`, não executar rollback destrutivo. Uma migration de roll-forward recria a coluna e o `CHECK`; se o alvo continuar sendo a release dual-compatible, restaura todos os projetos como `manual` e mantém constraints. Se o alvo for o baseline pré-compatibilidade, aplica também as relaxações de nullabilidade e referência descritas acima antes do deploy.

Se a migration falhar antes do commit, a transação inteira é revertida. Se o frontend falhar depois do commit, manter o banco migrado e reimplantar a release dual-compatible, que já suporta manual. Nunca desfazer parcialmente o backfill em produção.

## Testes exigidos

- Migration local partindo de: projeto schema-version sem rodada; schema-version com rodadas inativas; manual com zero/uma/várias rodadas; respostas humanas e LLM latest/superseded/parciais; collision de label; vínculos cross-project; overrides válidos e inválidos.
- Assert de idempotência operacional via reset completo: uma migration transacional falha sem deixar resíduos e passa do zero no segundo reset.
- Backend: `_build_llm_response_row()` sempre inclui a rodada capturada no início da run; todos os documentos de uma mesma run usam o mesmo snapshot.
- Backend pós-migration: ausência de `current_round_id` falha antes do processamento externo e nenhum select ou branch referencia `round_strategy` antes do cleanup.
- Backend/frontend LLM: `pending` e `max_responses` têm a mesma semântica por rodada.
- Frontend LLM: resumo inicial, `getEligibleDocCount()` e `getDocumentsForSelection()` usam o mesmo conjunto da rodada atual; durante compatibilidade, projetos `schema_version` mantêm a semântica global até o backfill.
- Frontend `rounds.test.ts`: somente `round_id`; parcial continua pendente; atual/anterior/todas; URL desconhecida; ausência de contexto inválido não recebe fallback silencioso.
- Página Codificar: fixture com resposta humana latest e superseded do mesmo documento prova que apenas a latest determina status, respostas e data exibidos.
- Actions: save humano sempre envia `current_round_id`; ausência recebe erro; `setCurrentRound(null)` não existe; exclusão usada é explicada.
- Compatibilidade: `setRoundStrategy()` não altera dados durante a janela, e o `CHECK` manual-only barra tentativa direta de restaurar `schema_version` depois do backfill.
- Criação de projeto: falha em qualquer insert reverte projeto, membership e rodada.
- SQL local: atualizar `frontend/supabase/tests/atomic_replace_rpcs.test.sql`, que hoje insere projeto sem `current_round_id` e resposta sem `round_id`, para criar a rodada/ponteiros válidos dentro da transação diferida; executar o arquivo após `supabase db reset`.
- Testes de comparação existentes executados sem alteração de fixtures/produto, salvo ajustes mecânicos de `Project` quando o tipo remover `round_strategy`.

## Critérios de aceite

- Nenhum projeto ou resposta pode ser persistido sem rodada após a migration.
- Nenhum vínculo de rodada pode cruzar projetos.
- Nova resposta humana ou LLM recebe o `current_round_id` capturado para a operação.
- Mudar semver não altera a fila da aba Codificar.
- Criar e tornar atual uma rodada nomeada altera a fila da Codificação de forma previsível.
- Projeto novo nasce com `Rodada inicial` de forma transacional.
- A migration bloqueia casos ambíguos e preserva todos os `round_id` já não nulos.
- A aba Comparar não recebe lógica, filtro ou query de rodada.
- O runbook produz contagens pré/pós e um caminho de rollback baseado em snapshot, sem depender de adivinhação.

## Fora de escopo

- Trocar o filtro de versão da Comparação por filtro de rodada.
- Alterar `responseQualifiesForVersion()`, `versionGate()`, `compare-sync.ts` ou as regras de automação/fecho de comparação.
- Remover semver ou o log de mudanças do schema.
- Inferir rodada histórica por timestamps quando o projeto manual tem múltiplas rodadas.
- Aplicar migration, alterar dados de produção ou executar deploy neste PR de proposta.
