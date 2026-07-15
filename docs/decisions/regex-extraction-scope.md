# Proposta de contrato para extração por regex

**Status:** proposta, sem implementação

**Issue:** [#138](https://github.com/bdcdo/dataframeitGUI/issues/138)

**Data:** 2026-07-15

## Decisão resumida

A primeira versão deve tratar regex como uma terceira origem de resposta, separada de pessoas e LLM, e deve começar com um contrato deliberadamente estreito: cada campo regex extrai uma única captura textual, usando o primeiro match da esquerda para a direita. O campo fica fora dos formulários humanos e do modelo enviado ao LLM; o resultado aparece na exportação individual, mas nunca participa da fila, do cálculo de concordância nem do gabarito de comparação.

A execução só pode ser implementada depois de selecionar e testar uma engine com semântica de tempo linear para o subconjunto aceito, além de isolamento e limite de tempo por documento. A stack atual não contém uma dependência de regex com esse contrato: o backend usa Python 3.11+ e o `pyproject.toml` não declara engine dedicada. Portanto, esta proposta define requisitos e um gate de seleção, sem escolher um pacote não verificado e sem autorizar o uso direto de `re` sobre padrões fornecidos por coordenadores.

## Estado atual verificado

O contrato vigente está espalhado por pontos que precisam mudar em conjunto:

1. [`PydanticField`](../../frontend/src/lib/types.ts) é hoje uma interface única com `target?: "all" | "llm_only" | "human_only" | "none"`.
2. [`generatePydanticCode()`](../../frontend/src/lib/schema-utils.ts) serializa metadata em `json_schema_extra`, e [`compile_pydantic()`](../../backend/services/pydantic_compiler.py) recompõe os campos a partir desse código sem executar o conteúdo do coordenador.
3. As primitivas `snapshotOf`, `classifyChange`, `diffFields` e `fieldDiffIsStructural`, no mesmo `schema-utils.ts`, governam versão e auditoria; [`schema-change-diff.ts`](../../frontend/src/lib/schema-change-diff.ts), [`schema-change-format.ts`](../../frontend/src/lib/schema-change-format.ts) e [`FieldChangeDiff.tsx`](../../frontend/src/components/schema/FieldChangeDiff.tsx) governam o histórico visível.
4. [`responses.respondent_type`](../../frontend/supabase/migrations/001_initial_schema.sql) tem uma constraint que aceita somente `humano` e `llm`.
5. A exportação já carrega `respondent_type`, mas [`sourceOf()`](../../frontend/src/lib/export/assemble.ts) converte qualquer valor diferente de `llm` em `codificacao`, e o cálculo de concordância usa todas as respostas recebidas.
6. A comparação e as revisões tipam e filtram respostas como `humano | llm` em vários limites. Apenas adicionar um terceiro valor no banco deixaria esses caminhos semanticamente ambíguos.
7. [`FieldCard`](../../frontend/src/components/schema/FieldCard.tsx) e [`EditFieldDialog`](../../frontend/src/components/stats/EditFieldDialog.tsx) são os dois editores obrigatórios de propriedades de `PydanticField`.

## Objetivos e limites da primeira versão

A primeira versão deve permitir que um coordenador configure extrações simples e reproduzíveis, visualize o resultado antes de gravar, execute um job auditável e exporte a captura. Ela não deve tentar ser uma linguagem de transformação, substituir um pipeline ETL ou inferir valores complexos a partir de múltiplos matches.

Ficam fora da primeira versão: múltiplas capturas por campo, campos `multi`, coerção para `single` ou `date`, subcampos, condições entre perguntas, substituição de texto, lookbehind, backreferences, execução de código, flags livres da engine e participação da saída regex em comparação ou gabarito. Cada uma dessas extensões exige semântica própria e não deve ser representada por fallback implícito.

## Contrato representável em `PydanticField`

O estado “campo marcado como regex, mas sem padrão executável” deve ser irrepresentável. Para isso, `PydanticField` deve virar uma união discriminada entre campos respondidos pelos fluxos existentes e campos de extração regex.

```ts
type RegexFlag = "ignore_case" | "multiline" | "dot_all";

interface RegexExtractionConfig {
  pattern: string;
  flags: RegexFlag[];
  group: number | string;
}

interface BasePydanticField {
  name: string;
  description: string;
  help_text?: string;
  required?: boolean;
  hash?: string;
}

type RegexPydanticField = BasePydanticField & {
  type: "text";
  options: null;
  target: "regex_only";
  regex: RegexExtractionConfig;
  subfields?: never;
  subfield_rule?: never;
  allow_other?: never;
  condition?: never;
  justification_prompt?: never;
};

type InteractivePydanticField = BasePydanticField & {
  type: "single" | "multi" | "text" | "date";
  options: string[] | null;
  target?: "all" | "llm_only" | "human_only" | "none";
  regex?: never;
  // propriedades interativas atuais
};

export type PydanticField = InteractivePydanticField | RegexPydanticField;
```

`target` é o único discriminante: `regex_only` implica a presença de `regex`, enquanto os quatro targets interativos proíbem essa propriedade. O objeto interno não repete `kind` nem outra marca de origem que possa divergir do target. `flags` é sempre um array explícito, mesmo quando vazio, ordenado canonicamente na sequência `ignore_case`, `multiline`, `dot_all` e sem duplicatas. `group` também é explícito: `0` significa o match inteiro; um inteiro positivo seleciona um grupo numerado; uma string seleciona um grupo nomeado. A UI não deve gravar defaults ausentes que o compilador precise adivinhar.

O executor usa somente o primeiro match, da esquerda para a direita, e devolve uma string. Se o padrão não casar, a chave do campo fica ausente em `answers`; se o grupo configurado não existir, o documento é contabilizado como erro de configuração. Se houver matches adicionais, o preview mostra a quantidade e a execução preserva apenas o primeiro. Esse comportamento deixa a cardinalidade definida sem inventar concatenação, separador ou coerção.

O validador do schema deve rejeitar padrão vazio, padrão acima de 2.048 bytes UTF-8, flags fora da allowlist, grupo numérico negativo, grupo nomeado vazio e qualquer combinação que viole a união. O teto de 2.048 bytes é um limite proposto de defesa em profundidade, não uma medição de performance realizada nesta sessão.

## Round-trip e versionamento obrigatórios

O código Pydantic continua sendo a fonte de verdade. Um campo regex deve ser emitido assim, com valores meramente literais dentro de `json_schema_extra`:

```py
processo: str = Field(
    description="Número do processo",
    json_schema_extra={
        "target": "regex_only",
        "regex": {
            "pattern": "...",
            "flags": ["ignore_case"],
            "group": "numero",
        },
    },
)
```

A implementação só está completa quando atualizar, no mesmo PR, todos estes consumidores:

1. `generatePydanticCode()` deve emitir `target` e o objeto `regex` em ordem canônica.
2. `compile_pydantic()` deve validar e reconstruir exatamente o objeto, sem aceitar chaves extras nem normalizar silenciosamente valores inválidos.
3. `snapshotOf`, `classifyChange`, `diffFields` e `fieldDiffIsStructural` devem registrar `regex` como propriedade estrutural; qualquer mudança em padrão, flags ou grupo deve gerar versão MINOR, pois pode alterar respostas produzidas.
4. `FieldPropertyDiff`, `diffPydanticField`, `PROPERTY_LABELS` e `FieldChangeDiff` devem exibir a alteração no histórico sem revelar o padrão apenas como um JSON opaco.
5. `FieldCard` e `EditFieldDialog` devem expor a mesma configuração e a mesma validação.
6. Os filtros de campos humanos, LLM, comparação, completude, comentários e exportação devem reconhecer `regex_only` explicitamente. Não é aceitável depender de “valor desconhecido cai no ramo existente”.
7. Testes de round-trip devem afirmar igualdade estrutural `UI -> pydantic_code -> compile_pydantic -> UI`, inclusive flags vazias, grupo `0`, grupo nomeado, escapes, Unicode e rejeição de chave extra.

## Seleção e isolamento da engine

Depois de compilado um padrão limitado pelo teto deste contrato, a engine deve garantir tempo linear no tamanho do texto para todo recurso aceito, sem backtracking exponencial. Compilação tem orçamento separado e também limitado por tempo e memória; a proposta não presume uma garantia assintótica mais forte em função simultânea do padrão e do texto. O produto deve rejeitar construções fora desse subconjunto no momento de salvar o schema, com mensagem indicando o recurso incompatível. Backreferences, lookaround e recursão ficam proibidos na primeira versão porque engines lineares usualmente não os oferecem e porque aceitá-los por um segundo caminho reintroduziria ReDoS.

O gate de seleção deve comparar candidatos compatíveis com Python 3.11+ e com a imagem de deploy atual, verificando: instalação reproduzível por `uv`, licença, suporte a Unicode, grupos numerados e nomeados, as três flags propostas, comportamento de `^`/`$`, limites de memória e manutenção do pacote. O resultado do spike deve entrar em ADR próprio com uma matriz executável; esta proposta não nomeia um vencedor.

Mesmo com semântica linear, a execução deve ocorrer fora do event loop e fora do processo que atende FastAPI. Cada worker recebe apenas o padrão compilado e o texto de um documento, sujeito a um teto próprio de 3.500.000 bytes UTF-8, limite inicial proposto de 250 ms por documento e encerramento forçado do worker quando o limite expirar. O número coincide com o teto conservador atual do upload, mas as invariantes são distintas: `MAX_CHUNK_BYTES` limita o documento serializado completo, inclusive metadata, e não constitui validação de `documents.text`; por isso, o executor mede o texto de novo e rejeita acima do próprio teto. O tempo deve ser calibrado no spike, mas não pode virar um `try/except` que deixa a mesma computação continuar em background.

O padrão deve ser compilado uma vez por campo e job. Erro de compilação encerra o job antes de processar qualquer documento; erro ou timeout em um documento não cancela resultados válidos dos demais, mas fica contabilizado e visível. Logs não devem incluir o texto integral do documento nem capturas; podem registrar `project_id`, `run_id`, `document_id`, campo, duração, status e tipo de erro.

## Preview

`POST /api/regex/preview` deve exigir o mesmo gate de coordenador usado pelas rotas de Pydantic e LLM. A requisição recebe `project_id`, o campo e a configuração ainda não salva; o backend volta a validar o contrato e não confia apenas na UI.

O preview processa no máximo 20 documentos por chamada, em ordem determinística por `created_at, id`, ou os IDs explicitamente escolhidos pelo coordenador. Para cada documento, retorna somente identificação, captura, número total de matches e um trecho limitado ao redor do match; não grava `responses`, jobs nem schema. A UI deve distinguir `match`, `sem match`, `grupo inválido`, `padrão rejeitado` e `timeout`.

## Persistência, idempotência e auditoria

A execução persistente deve usar um `run_id` UUID gerado antes da chamada. Repetir a mesma chamada com o mesmo `run_id` deve retomar ou devolver o mesmo job; uma nova execução recebe outro UUID. Falha de transporte não pode criar duas respostas atuais para o mesmo documento.

Uma migration dedicada deve criar `regex_runs`, com `id`, `project_id`, `created_by`, timestamps, status, contadores, hash e snapshot imutável das configurações usadas, além de `UNIQUE (id, project_id)` para sustentar o vínculo composto das respostas. O snapshot é obrigatório porque o coordenador pode alterar o schema durante a execução. A tabela deve ter RLS de leitura para membros, sem policy de escrita direta para `authenticated`; a rota valida o coordenador e o job autorizado grava com service role, ou por uma RPC `SECURITY DEFINER` estreita que repita o mesmo gate. Texto de documento e capturas não entram no snapshot.

`responses` deve ganhar `regex_run_id` nullable e uma unicidade por `(regex_run_id, document_id)`. Uma FK composta `(regex_run_id, project_id) -> regex_runs(id, project_id)` torna impossível associar a resposta a um run de outro projeto. Duas constraints completam a união no banco: `respondent_type = 'regex'` exige `regex_run_id IS NOT NULL` e `respondent_id IS NULL`; qualquer outro `respondent_type` exige `regex_run_id IS NULL`. O job grava no máximo uma resposta regex por documento, agregando todos os campos regex configurados no snapshot. Ao concluir um documento, uma operação transacional marca a resposta regex anterior como `is_latest = false` e insere ou atualiza a resposta do mesmo `run_id`; retry do lote é idempotente.

As policies atuais de `responses` precisam ser separadas por origem. Mutação direta por `authenticated`, inclusive coordenador, aceita somente `respondent_type = 'humano'`, `regex_run_id IS NULL` e um `respondent_id` pertencente às identidades do próprio chamador naquele projeto; a permissão administrativa sobre respostas humanas pode continuar em policy própria, mas nunca autoriza criar ou alterar linhas regex. LLM e regex são gravados somente pelos jobs autorizados depois dos respectivos gates de coordenador. Assim, um pesquisador não consegue injetar `respondent_type = 'regex'` usando o próprio `respondent_id`, e nem um coordenador contorna o snapshot auditável com INSERT direto.

O payload de resposta usa `respondent_type = "regex"`, `respondent_id = null`, `respondent_name = "Regex"`, `pydantic_hash`, `answer_field_hashes` e a versão do schema capturada no início. `is_partial` fica verdadeiro quando algum campo não teve match ou falhou. Os contadores de `regex_runs` distinguem documentos completos, parciais, sem match e com erro, com no máximo 100 amostras de erro sem conteúdo sensível; o histórico completo dos valores permanece nas próprias versões de `responses`.

## Exportação e comparação

A constraint de `responses.respondent_type` deve passar a aceitar `regex`, e os tipos TypeScript devem deixar de presumir que toda máquina é LLM. A expansão só é segura depois de auditar cada query que lê `responses`.

A aba/planilha de respostas individuais e o CSV devem incluir linhas regex com `respondent_type = regex` e `source = regex`. Campos `regex_only` aparecem como colunas nessa visão. Respostas humanas e LLM deixam essas colunas vazias; a resposta regex carrega os valores extraídos.

O gabarito e o cálculo de concordância devem receber somente respostas `humano` e `llm` segundo as regras atuais, e somente campos comparáveis segundo os targets atuais. Campos `regex_only` e respostas `regex` ficam excluídos na fronteira que monta a comparação, não por uma condição espalhada dentro dos componentes. A fila, equivalências, auto-revisão, arbitragem, comentários de LLM e estatísticas humano-versus-LLM devem manter uniões fechadas e rejeitar `regex` quando chegar por engano.

## Interface do coordenador

O editor de schema oferece “Extração regex” como origem do campo, não como checkbox independente. Ao selecioná-la, o tipo fica `text`, as propriedades incompatíveis desaparecem e a configuração exige padrão, flags e grupo. Sair desse modo exige confirmação se houver padrão configurado.

Uma aba de projeto “Regex”, visível somente a coordenadores, reúne três áreas: campos configurados, preview e execuções. A ação padrão roda todos os campos regex sobre todos os documentos ativos; filtros ou execução de um único campo podem ser adicionados depois, sem alterar o contrato persistido. O progresso segue o padrão visual da aba LLM, mas jobs e respostas continuam semanticamente separados.

Toda informação codificada por cor deve ter rótulo textual, e estados de match/erro precisam de ícone ou texto redundante. O trecho de preview deve marcar a captura sem depender apenas de fundo colorido e manter contraste mínimo de 3:1 para a marcação sobre o texto.

## Fases propostas

### Fase 0 — spike de engine

Selecionar e validar a engine com corpus de padrões válidos, padrões rejeitados, Unicode, textos até 3,5 MB e casos adversariais conhecidos. A fase termina apenas com tempo e memória medidos, decisão documentada e mecanismo comprovado de interrupção do worker.

### Fase 1 — contrato de schema

Implementar a união discriminada, os dois editores, round-trip completo, histórico e filtros de visibilidade, ainda sem executar padrões. Ao final, o schema consegue registrar de forma íntegra o trabalho futuro, que é o escopo mínimo pedido no comentário da issue.

### Fase 2 — preview seguro

Adicionar rota autenticada, worker isolado e preview limitado a 20 documentos, sem persistência.

### Fase 3 — jobs e respostas exportáveis

Adicionar migrations, jobs idempotentes, respostas `regex`, exportação e tela de execuções. A comparação permanece fechada para humano/LLM.

### Fase 4 — extensões deliberadas

Avaliar múltiplos matches, tipos além de texto e execução seletiva somente a partir de casos reais. Cada extensão muda o discriminante ou adiciona uma variante explícita; não deve reutilizar strings ou arrays implícitos.

## Critérios de aceite da proposta futura

- Um campo regex inválido não pode ser construído pela UI, aceito pelo compilador nem perdido no round-trip.
- Padrão, flags e grupo sobrevivem byte a byte ao round-trip e aparecem no histórico como mudança MINOR.
- O preview nunca persiste dados e processa no máximo 20 documentos por chamada.
- A engine aceita apenas o subconjunto linear documentado; padrões adversariais não bloqueiam o processo FastAPI e o worker é encerrado no limite configurado.
- Repetir um `run_id` não duplica job nem resposta por documento.
- A exportação individual inclui `respondent_type = regex` e `source = regex`.
- Nenhuma resposta ou campo regex altera fila, concordância, equivalência, auto-revisão, arbitragem ou gabarito.
- Testes de constraints e RLS provam que pesquisador não inicia execução, não lê projeto alheio, não injeta resultado regex com o próprio `respondent_id` e não associa resposta a run de outro projeto.

## Alternativas rejeitadas

Adicionar somente `target: "regex"` foi rejeitado porque recria o estado malformado identificado na issue: o campo fica oculto, mas não existe padrão executável. Guardar o padrão apenas em `projects.pydantic_fields` foi rejeitado porque viola o código Pydantic como fonte de verdade. Rodar `re` diretamente no FastAPI foi rejeitado porque a stack verificada não oferece timeout seguro por match e padrões fornecidos por usuário podem causar ReDoS. Reutilizar `respondent_type = llm` ou `llm_runs` foi rejeitado porque tornaria extração determinística indistinguível de inferência e poluiria comparação, métricas e auditoria.
