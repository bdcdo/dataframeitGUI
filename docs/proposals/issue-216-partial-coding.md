# Proposta: completar campos de uma codificação existente

Status: proposta para implementação, sem migration aplicada e sem alteração de dados remotos.

Referência: `Refs #216`.

## Decisão

A solução deve atualizar a única resposta humana ativa do pesquisador, sem criar um segundo voto e sem regravar o formulário inteiro. O cliente declara quais campos foram tocados e quais foram explicitamente revisados; o servidor faz um merge atômico sobre a resposta mais recente, preserva respostas e hashes não revisados e atualiza o hash apenas dos campos que o pesquisador de fato revisou.

`is_latest` continua significando “resposta humana ativa deste respondente para este documento”, não “resposta integralmente compatível com o schema atual”. A linha permanece `is_latest=true`. A atualidade de cada campo continua sendo determinada por `answer_field_hashes`.

Não proponho criar uma nova linha em `responses` a cada complementação. Hoje o fluxo humano já atualiza a linha ativa in-place; criar uma cópia aumentaria a contagem de votos e exigiria uma troca transacional de `is_latest`. Isso não torna seguro ignorar artefatos derivados: reviews, `field_reviews` e equivalências que dependam de um campo alterado precisam ser bloqueados ou reconciliados explicitamente, como definido abaixo. Histórico por campo pode ser uma evolução própria, mas não é necessário para resolver a #216.

## Evidência no código atual

O fluxo atual não permite um patch honesto:

- `frontend/src/actions/responses.ts::buildResponsePayload()` recebe o objeto completo de respostas e reconstrói `answer_field_hashes` a partir de todos os campos do schema atual. Abrir uma codificação antiga e salvar um único campo, portanto, marca silenciosamente todos os campos como atuais.
- `frontend/src/actions/responses.ts::upsertResponseRow()` atualiza a linha humana ativa, mas o fetch dessa linha traz apenas `id` e `is_partial`; não há respostas, justificativas, hashes nem `updated_at` para um merge com proteção contra concorrência.
- `frontend/src/app/(app)/projects/[id]/analyze/code/page.tsx` não seleciona `id`, `is_latest`, `answer_field_hashes` ou `pydantic_hash`. A UI recebe valores, mas não recebe a proveniência necessária para separar campo ausente de campo alterado.
- `frontend/src/components/coding/useAssignedCoding.ts` envia o estado inteiro a `saveResponse()`. O dirty tracking existe por documento, não por campo.
- `frontend/src/actions/schema.ts::persistResponseVersionUpdates()` também faz `UPDATE responses` direto para o backfill histórico de semver. Retirar a policy genérica exige migrar esse caller para uma operação coordenadora própria; ele não pode ser confundido com edição humana nem parar silenciosamente por RLS.
- `frontend/src/lib/compare-divergence.ts::responseHadField()` distingue campo ausente em snapshots não legados, enquanto `frontend/src/lib/reviews/queries.ts::isFieldStale()` e `frontend/src/components/compare/useCompareFieldData.ts` comparam o hash salvo com o atual. As regras estão hoje espalhadas e precisam de uma primitiva única antes de serem expostas na Codificação.
- `frontend/src/lib/coding-completeness.ts::isCodingComplete()` ignora, de propósito, campos que não existiam quando uma resposta antiga foi feita. Essa é a regra correta para avaliar retrospectivamente o backlog, mas não serve para dizer que a complementação atual terminou.

## Estado por campo

Criar uma primitiva pura compartilhada, por exemplo `classifyResponseFieldState(field, answerFieldHashes)`, com quatro resultados:

| Estado | Condição | Ação na UI |
| --- | --- | --- |
| `current` | o snapshot contém `field.name` e o hash salvo é igual ao hash atual | mostrar como preservado; não enviar como revisado automaticamente |
| `missing` | o snapshot é não legado e não contém `field.name` | solicitar preenchimento quando o campo estiver visível |
| `stale` | o snapshot contém o campo, mas o hash salvo difere do atual | mostrar o valor antigo e exigir alteração ou confirmação explícita |
| `legacy` | `answer_field_hashes` é `null` ou `{}` e não há proveniência por campo | não oferecer complementação automática; exigir revisão integral |

Um valor ausente em `answers` não basta para classificar um campo como novo: campos opcionais podiam existir e ficar em branco. A distinção vem do snapshot de hashes.

Campos `target="llm_only"` ou `target="none"` ficam fora da complementação humana. Campos condicionais ocultos ficam fora da lista de pendências e são tratados pela limpeza descrita abaixo.

## Fila de complementos não é rodada

`classifyDocStatus()` e o filtro de rodada continuam respondendo se houve uma submissão naquela rodada. Eles não devem passar a usar hashes de campo como substituto de `round_id`: isso recriaria, por outro nome, o acoplamento entre mudança de schema e fila de rodada que a #223 remove.

A Codificação precisa derivar em paralelo um estado `needsFieldComplement` para respostas humanas latest, submetidas e não legadas. A UI oferece um filtro/badge explícito “Complementos” e também mostra o estado ao abrir a resposta por “Todas”. Uma resposta pode estar `current_done` para a rodada e, ao mesmo tempo, precisar de 3 complementos; esses estados não se sobrescrevem.

Uma complementação parcial preserva `round_id`, `is_partial=false` e o status concluído do assignment original. Ela não pode fazer uma resposta de rodada anterior contar como submissão da rodada atual. A ação separada “Revisar codificação completa” continua sendo a operação que confirma o formulário como um todo, associa a resposta à rodada atual e segue o fluxo normal de assignment.

## Contrato da mutation

A mutation parcial deve ser separada do save integral para impedir que um caller antigo entre acidentalmente no novo contrato. Nome sugerido: `completeResponseFields()` no frontend e `merge_human_response_fields()` no banco.

```ts
interface CompleteResponseFieldsInput {
  projectId: string;
  documentId: string;
  responseId: string;
  expectedUpdatedAt: string;
  answerPatch: Record<string, unknown>;
  justificationPatch?: Record<string, unknown>;
  touchedFields: string[];
  reviewedFields: string[];
  notes?: { touched: boolean; value: string };
}
```

As invariantes do contrato são:

1. `touchedFields` e `reviewedFields` não podem conter duplicatas, e `touchedFields` deve ser subconjunto de `reviewedFields`.
2. As chaves próprias de `answerPatch` devem ser exatamente `touchedFields`. Assim, chave presente com `null` representa uma limpeza deliberada; chave ausente representa preservação.
3. Todo campo revisado deve existir no schema corrente, ter hash atual não vazio, ser destinado a humano e estar visível depois do merge. O valor resultante precisa ser válido para o shape completo de `PydanticField`: scalar/array conforme o tipo, opções ou `Outro:`, formato de data e regras de `subfields`. Um campo `stale` pode ser revisado sem ser tocado somente quando o valor antigo ainda é válido sob esse mesmo contrato e a UI exibiu uma ação explícita de “Confirmar valor”.
4. Campo `missing` obrigatório precisa ser tocado e receber um valor completo. Campo opcional ausente pode ser revisado sem resposta apenas por uma ação explícita de “Confirmar sem resposta”; abrir, focar ou submeter outro campo não adiciona seu hash.
5. A mutation parcial exige uma resposta humana ativa, não legada e já submetida (`is_partial=false`). Se não houver linha ou a resposta ainda for um autosave parcial, o fluxo integral continua responsável pelo primeiro envio.
6. `responseId` deve ser a linha `is_latest=true` da identidade efetiva, no mesmo projeto e documento. O servidor não aceita `respondent_id`, nome, hashes ou versão fornecidos pelo cliente.
7. `expectedUpdatedAt` implementa concorrência otimista. Se a linha mudou desde a renderização, a mutation devolve conflito e a UI recarrega os estados por campo; nunca aplica um patch sobre uma base diferente em silêncio.

As chaves de `justificationPatch` devem ser subconjunto de `touchedFields`; `notes.touched=false` preserva `_notes` sem reserializar o objeto de justificativas.

O formulário deve manter conjuntos por documento, por exemplo `touchedFieldsByDoc` e `reviewedFieldsByDoc`. Alterar um input inclui o nome nos dois conjuntos. Confirmar um valor antigo inclui apenas em `reviewedFields`. Renderizar ou focar um campo não o inclui em nenhum conjunto.

O save integral continua existindo para a primeira resposta, para concluir um autosave parcial e para a ação explícita “Revisar codificação completa”. Quando já existe uma linha, esse fluxo também usa uma RPC de domínio, com todos os campos humanos finalmente visíveis declarados como revisados; a UI deve comunicar que o submit confirma o formulário inteiro e pode mover a resposta para a rodada atual. Nenhum fluxo de resposta existente volta a fazer `UPDATE responses` genérico depois que a policy direta for removida.

## Merge atômico no servidor

O merge precisa acontecer numa única transação de banco. A RPC deve usar `SECURITY DEFINER`, `SET search_path = ''`, conferir `clerk_uid()`/identidade efetiva e receber apenas os argumentos do contrato. `PUBLIC` e `anon` não recebem `EXECUTE`; `authenticated` recebe somente a função específica. A função não desabilita nem contorna o trigger estrutural da #134.

Ordem proposta dentro da RPC:

1. Carregar e bloquear com `FOR UPDATE` o projeto, o documento e a resposta indicada.
2. Validar projeto acessível, documento não excluído, identidade humana efetiva, `is_latest=true`, `responseId` e `expectedUpdatedAt`.
3. Ler o schema corrente do projeto e validar os conjuntos `touchedFields`/`reviewedFields`.
4. Começar com cópias de `OLD.answers`, `OLD.justifications` e `OLD.answer_field_hashes`.
5. Aplicar apenas as chaves de `answerPatch` e `justificationPatch` declaradas como tocadas.
6. Para cada campo explicitamente revisado, gravar o hash corrente daquele campo. Não iterar o schema inteiro para preencher hashes.
7. Avaliar as condições sobre o objeto resultante até ponto fixo. Para cada campo condicional que terminou oculto, remover a chave de `answers`, a justificativa do campo e a chave correspondente de `answer_field_hashes`, mesmo que esse campo não estivesse em `touchedFields`. Uma resposta oculta não pode permanecer como estado persistível.
8. Preservar sem alteração as respostas, justificativas e chaves de hash dos demais campos, inclusive campos antigos que não existem mais no schema e campos atuais ainda `stale` que não foram revisados.
9. Antes de persistir, aplicar o gate de artefatos derivados descrito abaixo a todos os campos tocados, confirmados ou removidos por condição.
10. Atualizar a resposta com compare-and-swap sobre `id` e `updated_at`; o relógio vem do banco. Preservar `round_id`, `is_partial=false` e o assignment de codificação já concluído.
11. Retornar o snapshot persistido, os campos que ficaram `missing`/`stale` e os condicionais removidos. Depois do commit, reconciliar a automação somente para os campos afetados; falha dessa etapa precisa ficar observável e recuperável por retry, sem desfazer o merge já confirmado.

O núcleo de condição deve seguir exatamente as operações aceitas por `FieldCondition` (`equals`, `not_equals`, `in`, `not_in`, `exists`) e a limpeza em ponto fixo de `dropHiddenConditionals()`. A implementação SQL precisa de testes de contrato com os mesmos fixtures usados pela primitiva TypeScript para impedir drift.

Exemplo: a resposta antiga tem `{q1: "sim", detalhe: "texto", q3: "A"}` e hashes `{q1: "h1-old", detalhe: "hd-old", q3: "h3-current"}`. O pesquisador altera apenas `q1` para `"não"`, declarando `touched=[q1]` e `reviewed=[q1]`. Se `detalhe` depende de `q1 == "sim"`, o resultado deve ser `{q1: "não", q3: "A"}` e hashes `{q1: "h1-current", q3: "h3-current"}`. O hash de `q3` permanece; resposta, justificativa e hash de `detalhe` somem juntos.

## Metadados da resposta

- `is_latest`: permanece `true`; a complementação não cria outro voto.
- `is_partial`: a complementação só aceita uma resposta já submetida e preserva `false`. Autosave parcial e primeira submissão pertencem ao fluxo integral; falta de outro complemento não reabre silenciosamente o ciclo já concluído.
- `pydantic_hash` e `schema_version_*`: registram o schema sob o qual ocorreu o último save, mas não substituem a proveniência por campo. Eles podem avançar para a versão corrente na mutation; os hashes não revisados permanecem antigos, de modo que nenhum campo é promovido silenciosamente. Toda leitura que decide atualidade por campo deve preferir `answer_field_hashes` quando o snapshot existe.
- `round_id`: a complementação preserva a rodada da resposta. Somente “Revisar codificação completa” representa nova submissão e pode gravar a rodada corrente. Após a #223, a fila por rodada e a fila de campos pendentes continuam conceitos distintos: rodada responde “em qual ciclo houve a submissão integral”, hashes respondem “quais perguntas foram revistas”.
- `updated_at`: sempre atribuído no banco e usado como token de concorrência.

Como `schema_version_*` passa a descrever o último save de uma linha possivelmente mista, a implementação deve revisar os consumidores que hoje tratam semver como prova de atualidade integral. Para campos, `answer_field_hashes` é a fonte de verdade. O filtro de versão da Comparação continua sendo uma lente de linha, não uma garantia de que todo campo da linha está atual.

## Compatibilidade com a proposta da #134

A migration ainda não mergeada da #134 contém `enforce_response_owner_column_guard()`, que hoje exige, tanto em `INSERT` quanto em `UPDATE`, `answer_field_hashes` exatamente iguais ao conjunto inteiro de hashes do schema corrente. Essa igualdade é incompatível com a #216 porque apagaria a proveniência dos campos não revisados.

A integração deve seguir este corte:

1. Manter inalterado o guard de `INSERT` da #134: primeira resposta humana continua exigindo projeto/documento válidos, identidade canônica, metadados do schema corrente, `is_latest=true` e snapshot completo de hashes. A edição parcial nunca usa `INSERT`.
2. Substituir a policy `Users manage own responses FOR ALL` por uma policy somente `FOR INSERT` para a resposta humana canônica. Não manter policy direta de `UPDATE` nem `DELETE`; updates existentes passam exclusivamente pela RPC `merge_human_response_fields()` e exclusão de resposta continua sendo operação administrativa explícita.
3. Manter a igualdade “hashes == schema inteiro” no ramo `TG_OP='INSERT'`. No ramo `UPDATE`, o trigger não pode virar apenas um guard de colunas: para qualquer caller, inclusive service role, ele deve rejeitar hash novo/alterado que não seja o hash corrente do campo, resposta alterada sem promoção correspondente do hash e remoção que não elimine em conjunto resposta, justificativa e hash de um campo comprovadamente oculto. A única exceção sem hash de campo é `_notes`, controlada separadamente por `notes.touched`. Hashes stale não tocados permanecem byte a byte iguais a `OLD`. A RPC acrescenta identidade, declaração explícita de campos e concorrência otimista, mas não é um bypass privilegiado desse contrato fail-closed.
4. Preservar a allowlist fail-closed da #134. Se a implementação adicionar metadado persistente, ele deve entrar explicitamente no contrato do trigger; esta proposta não exige coluna nova em `responses`.
5. Cobrir em teste SQL que `UPDATE` e `DELETE` diretos como pesquisador afetam zero linhas ou falham, enquanto a RPC consegue atualizar apenas a resposta própria, rejeita alias/projeto/documento incorretos e nunca altera `respondent_id`, `respondent_name`, `created_at`, `is_latest`, `is_partial`, `round_id` ou metadados LLM. Um teste com service role também precisa provar que o trigger rejeita promoção de hash inventado ou alteração de answer sem o delta canônico correspondente.
6. Migrar `persistResponseVersionUpdates()` para uma RPC coordenadora separada e estreita, autorizada a atualizar somente os metadados históricos que o backfill reconstruiu. Ela não usa `merge_human_response_fields()` e não ganha permissão para alterar answers/hashes. O teste de callers deve provar que nenhum `UPDATE responses` produtivo depende da policy removida.

Esse desenho não contorna o hardening da #134: preserva o guard forte de criação e reduz a superfície de atualização a uma operação de domínio menor e auditável.

## Reviews, equivalências e automação derivadas

Uma response é referenciada por `reviews.chosen_response_id`, `field_reviews.human_response_id`/`llm_response_id` e `response_equivalences`. Alterar seu conteúdo sem considerar essas tabelas pode fazer uma decisão antiga parecer aplicada a um valor que o revisor nunca viu.

A RPC calcula `affectedFields = touched ∪ reviewed ∪ conditionallyRemoved`. Para cada campo afetado:

1. se já existe decisão humana materializada — linha em `reviews`, equivalência, ou `field_reviews` com self/arbitragem iniciada — a mutation falha com erro de domínio e não altera nada; invalidar essa decisão exige um fluxo coordenado próprio, fora da #216;
2. um `field_reviews` ainda virgem, sem qualquer verdict/timestamp/arbitrator, pode ser removido e recriado na mesma transação; não pode sobreviver apontando para conteúdo alterado;
3. ausência de artefato é o caso esperado para um campo realmente novo e permite o merge;
4. depois do commit, a automação reavalia somente os campos afetados e pode criar a revisão que o novo valor exigir;
5. o retry não pode depender apenas dos helpers atuais com `upsert(..., ignoreDuplicates: true)`: assignments concluídos de auto-revisão/comparação não são reabertos por esse código. A implementação precisa de reconciliação idempotente que torne uma divergência nova visível sem apagar decisões de outros campos.

Campos removidos em cascata por condição entram no mesmo gate. A RPC não pode apagar uma resposta que sustenta review/equivalência já materializada e deixar o artefato apontando para outro conteúdo.

## Experiência na Codificação

No carregamento da página, buscar somente respostas humanas `is_latest=true` e incluir `id`, `answer_field_hashes`, `pydantic_hash`, `updated_at`, respostas, justificativas, versão e rodada. A ausência atual do filtro `is_latest` em `analyze/code/page.tsx` também deve ser corrigida para o `Map` não escolher uma linha histórica pela ordem incidental do PostgREST.

Para uma resposta não legada com pendências, o filtro “Complementos” e a tela mostram um banner como “3 perguntas precisam de complemento: 2 novas e 1 alterada”. O painel mantém as respostas atuais em contexto, mas recolhe ou deixa somente leitura os campos `current`; campos `missing` e `stale` ficam destacados. Campo alterado mostra “O formulário mudou desde sua resposta” e oferece editar ou confirmar o valor exibido.

O botão deve dizer “Salvar complemento” e informar quantas perguntas serão revistas. Se ainda restarem campos desatualizados, o documento permanece no filtro independente “Complementos”, sem reaparecer como pendente da rodada. Abrir e fechar sem tocar ou confirmar não gera mutation.

Respostas legadas (`null`/`{}`) recebem a ação “Revisar codificação completa”, porque não há evidência para atribuir atualidade por campo. Não inferir hashes pelo simples fato de a resposta atual caber nas opções atuais.

## Plano de implementação

1. Extrair e testar a classificação única `current`/`missing`/`stale`/`legacy`.
2. Adicionar as RPCs de merge e backfill histórico, a policy/guard compatível com #134 e testes SQL de autorização, concorrência, validação de valores, merge, condicionais e artefatos derivados.
3. Alterar a leitura de Codificação para selecionar somente a resposta latest, transportar proveniência/token de concorrência e derivar o filtro independente de complementos.
4. Adicionar dirty/reviewed tracking por campo nos modos Atribuídos e Explorar; autosave de primeira codificação continua no fluxo integral, enquanto complemento só envia o patch declarado.
5. Preservar estado de rodada/assignment na complementação e implementar a reconciliação idempotente pós-commit dos campos afetados.
6. Validar os consumidores de comparação, reviews, auto-review, export e rodadas com snapshots mistos.

## Matriz mínima de testes

- Campo novo ausente: preencher somente o novo campo preserva todos os valores e hashes antigos.
- Campo alterado: confirmar sem editar atualiza apenas o hash daquele campo quando o valor ainda é válido.
- Campo alterado com valor inválido: confirmação é rejeitada; é necessário tocar e fornecer valor válido.
- Dois campos stale, um revisado: o outro continua stale e seu hash não muda.
- Condicional ocultada por um campo tocado: resposta, justificativa e hash do filho são removidos em cascata.
- Condicional ainda visível e não revisada: valor e hash antigos são preservados.
- `answer_field_hashes=null` ou `{}`: complementação parcial é bloqueada e a UI oferece revisão integral.
- Concorrência: dois patches carregados do mesmo `updated_at`; o primeiro vence e o segundo recebe conflito sem sobrescrever.
- Identidade: pesquisador, alias efetivo, coordenador e outsider não conseguem editar a resposta de outra identidade por troca de argumentos.
- INSERT inicial continua obedecendo integralmente ao guard da #134.
- UPDATE/DELETE direto continua negado e service role não consegue fabricar delta de hash/answer que o trigger da #134 rejeitaria.
- Complemento preserva `round_id`, `is_partial=false` e assignment concluído; revisão integral é o único caminho que move a resposta para a rodada atual.
- Campo com review/equivalência materializada bloqueia o merge; campo novo sem artefato pode ser completado e gera reconciliação idempotente se divergir.
- Leitura da Codificação ignora linhas `is_latest=false`.

## Critérios de aceite

- Salvar um campo não modifica respostas, justificativas ou hashes de campos não revisados, exceto pela remoção obrigatória de condicionais que ficaram ocultas.
- Nenhum caminho preenche `answer_field_hashes` iterando todo o schema durante uma complementação parcial.
- O servidor rejeita patch sem declaração explícita de campos, snapshot concorrente ou tentativa sobre resposta inexistente/não latest.
- A UI separa campo novo, campo alterado e resposta legada sem inferir proveniência ausente.
- Resposta e token de concorrência não ficam em estados intermediários se a transação falhar; falha da reconciliação pós-commit fica registrada e retomável.
- Os testes SQL demonstram compatibilidade com o contrato de INSERT da #134 e ausência de UPDATE humano genérico.
- Uma complementação não muda rodada nem reabre a fila normal de codificação; pendências aparecem no filtro próprio.

## Fora de escopo

- Criar histórico imutável de cada revisão por campo.
- Alterar as regras da aba Comparar ou substituir seu filtro de semver.
- Backfill automático de hashes em respostas legadas sem evidência.
- Aplicar migration, alterar dados de produção ou executar deploy neste PR de proposta.
