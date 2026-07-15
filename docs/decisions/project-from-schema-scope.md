# Proposta para criar projeto a partir do schema de outro

**Status:** proposta, sem implementação

**Issue:** [#156](https://github.com/bdcdo/dataframeitGUI/issues/156)

**Data:** 2026-07-15

## Decisão resumida

A solução incremental recomendada é manter o schema inline em `projects` e oferecer uma operação transacional “novo projeto a partir de” que copie um snapshot. Não se cria uma tabela `schemas` nem uma referência compartilhada nesta etapa: os dois projetos passam a ter ciclos de vida independentes no instante da criação.

A operação copia somente schema, configuração de LLM e regras do projeto. Corpus, trabalho produzido e histórico operacional começam vazios. A equipe pode ser copiada por opção explícita, desligada por padrão, e o usuário que cria a nova instância sempre se torna seu criador e coordenador.

## Estado atual verificado

[`createProject`](../../frontend/src/actions/projects.ts) faz hoje dois inserts separados: primeiro em `projects`, depois em `project_members`. Se o segundo falhar, o projeto já existe sem o membro coordenador. A clonagem não deve reproduzir esse estado parcial; o limite transacional precisa estar no banco.

O workaround citado pela issue não está em `main`: a PR fechada [#155](https://github.com/bdcdo/dataframeitGUI/pull/155) continha `scripts/zolgensma/clone-project.mjs`, e seu patch foi consultado diretamente. O script usava service role, mantinha `created_by` da origem, copiava 10 campos de schema/configuração e, opcionalmente, `user_id`, `role` e `can_arbitrate`. Depois dele, o schema ganhou novas configurações de projeto e membro, de modo que copiar a lista histórica sem revisar as colunas produziria drift.

[`projects`](../../frontend/supabase/migrations/001_initial_schema.sql) contém hoje identidade, três representações do schema, configuração de LLM e regras. Migrations posteriores acrescentaram versão semântica, estratégia de rodadas, arbitragem cega, modo de automação, inclusão do LLM na comparação e controle de pedidos de exclusão. [`Project`](../../frontend/src/lib/types.ts) reflete as configurações operacionais; as três colunas de versão são selecionadas por shapes locais nos fluxos que precisam delas.

`project_members` contém hoje `role`, `can_arbitrate`, `can_resolve`, `can_compare`, `assignment_weight` e `assignment_cap`. Copiar apenas as três colunas do script antigo descartaria permissões e configuração de carga sem aviso.

`schema_change_log` registra mudanças por campo, alimenta o histórico e participa do backfill de versões. Ele não representa uma relação entre projetos: inserir uma entrada sintética de “clonagem” como se fosse edição de campo alteraria a interpretação de versões e snapshots. Por isso, esta proposta não reutiliza esse log para provenance.

## Contrato da cópia

### Valores fornecidos pelo coordenador

O formulário exige `name` e aceita `description`. `automation_mode` deixa de ser escolhido separadamente quando há projeto de origem porque a regra vem do snapshot; o resumo antes da confirmação mostra esse valor e permite que o coordenador o altere depois em Configurações.

O cliente gera um `request_id` UUID opaco uma única vez e o conserva durante retries da mesma submissão. Esse token nunca vira identidade do recurso: ele é escopado pelo ator autenticado e serve somente para idempotência. O cliente também envia `source_project_id` e `include_members`, cujo default é `false`.

### Colunas copiadas de `projects`

Estas colunas formam o snapshot recomendado:

- `pydantic_fields`, `pydantic_code` e `pydantic_hash`.
- `prompt_template`, `llm_provider`, `llm_model` e `llm_kwargs`.
- `resolution_rule`, `min_responses_for_comparison` e `allow_researcher_review`.
- `arbitration_blind`, `automation_mode`, `comparison_includes_llm` e `out_of_scope_enabled`.

As três representações Pydantic devem ser copiadas juntas, sem regenerar código no caminho da clonagem. A origem já tem a relação canônica entre campos, código e hash; regenerar uma parte durante o clone criaria um quarto comportamento de persistência e poderia alterar o snapshot.

### Valores novos ou resetados

- `id` é gerado pelo default do banco e nunca é aceito do cliente.
- `name` e `description` vêm do formulário.
- `created_by` recebe o usuário autenticado que pediu a cópia, nunca o criador da origem.
- `created_at` usa o default do banco.
- A versão inicial é `0.1.0`: `schema_version_major = 0`, `schema_version_minor = 1`, `schema_version_patch = 0`.
- `round_strategy` volta a `schema_version` e `current_round_id` fica `NULL`, porque rodadas manuais pertencem à instância e nenhuma rodada é copiada.

`0.1.0` é recomendado porque é o baseline codificado hoje em `schema-backfill.ts`; o backfill inicia nessa versão e reconstrói as mudanças a partir dela. Começar o clone em `1.0.0` sem também redesenhar esse algoritmo faria uma manutenção futura recalcular versões incompatíveis com o valor gravado. A provenance registra que o conteúdo veio de um schema já existente, enquanto a versão representa o ciclo independente da nova instância. Publicar `1.0.0` continua sendo o gesto manual de MAJOR já disponível ao coordenador.

### Equipe, quando a opção está ligada

A cópia da equipe preserva, para cada membro da origem, `user_id`, `role`, `can_arbitrate`, `can_resolve`, `can_compare`, `assignment_weight` e `assignment_cap`. `member_email_links` não é copiada: os aliases pertencem ao vínculo original e precisam de consentimento e pré-registro próprios no projeto novo.

O usuário que cria o projeto é inserido uma única vez como `coordenador`. Com `include_members = true`, se ele também estiver na equipe de origem, a função força apenas o `role`: preserva da linha original `can_arbitrate`, `can_resolve`, `can_compare`, `assignment_weight` e `assignment_cap`. Se ele não era membro da origem, grava explicitamente os defaults vigentes — três flags `false`, `assignment_weight = 1` e `assignment_cap = NULL`. Com `include_members = false`, nenhuma configuração de equipe é copiada e o criador recebe esses mesmos defaults explícitos. Os demais membros conservam exatamente os valores copiados, sem receber permissões por default novo.

### Dados que nunca são copiados

Não se copiam `documents`, `assignments`, `assignment_batches`, `responses`, `reviews`, `field_reviews`, `response_equivalences`, `rounds`, `llm_runs`, `project_comments`, `schema_suggestions`, `researcher_field_orders`, `question_meta`, `discussions`, `discussion_comments`, `difficulty_resolutions`, `error_resolutions`, `note_resolutions`, `verdict_acknowledgments` nem qualquer log derivado dessas entidades.

`schema_change_log` também não é copiado e começa vazio. O snapshot em `0.1.0` é a linha de base do projeto novo; a primeira edição posterior gera o primeiro evento normal segundo as primitivas canônicas de `schema-utils.ts`.

## Provenance e auditoria

O schema atual não tem uma coluna de origem de clone, e `description` é texto editável, inadequado como trilha de auditoria. A implementação deve tornar essa adição explícita por migration, em vez de fingir que a informação já cabe em outro contrato.

A proposta é uma tabela imutável `project_clone_events`, sem normalizar o schema compartilhado:

```sql
CREATE TABLE project_clone_events (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  source_project_id UUID NOT NULL,
  source_project_name TEXT NOT NULL,
  source_schema_version_major INTEGER NOT NULL,
  source_schema_version_minor INTEGER NOT NULL,
  source_schema_version_patch INTEGER NOT NULL,
  source_pydantic_hash TEXT,
  included_members BOOLEAN NOT NULL,
  copied_member_count INTEGER NOT NULL CHECK (copied_member_count >= 0),
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (created_by, request_id)
);
```

`source_project_id` fica sem FK de propósito: apagar a origem não pode apagar nem anular a identificação histórica. Nome, versão, hash, opção de equipe e quantidade efetivamente copiada são snapshots, não joins vivos. A tabela não recebe policy de INSERT, UPDATE ou DELETE para usuários autenticados; SELECT segue a mesma fronteira de acesso do projeto novo. A RPC é o único escritor.

A UI pode mostrar “Criado a partir de <nome>, schema <versão>” lendo esse evento. A descrição permanece conteúdo do coordenador, sem sufixo automático que ele precise apagar ou que pareça trilha imutável.

## Atomicidade e autorização

A criação deve ser uma RPC Postgres única, por exemplo `create_project_from_source`, porque uma chamada de função executa em uma transação e pode inserir projeto, criador, equipe opcional e evento de clone como uma unidade. A Server Action autentica, valida o payload e chama a RPC pelo cliente Clerk/RLS; service role não participa do fluxo de produto.

A RPC deve ser `SECURITY DEFINER` porque `project_clone_events` não concede INSERT direto a `authenticated`. Esse privilégio exige uma fronteira estreita: `SET search_path = ''`, objetos sempre qualificados com `public.`, `REVOKE ALL ... FROM PUBLIC, anon`, `GRANT EXECUTE ... TO authenticated`, identidade obtida por `public.clerk_uid()` e todas as checagens de autorização dentro da função antes de qualquer escrita. O definer não aceita `project_id`, valores de schema, ownership ou membros fornecidos pelo cliente.

Somente coordenador ou criador da origem, e master, pode clonar. Ser mero pesquisador permite ler o projeto, mas não copiar configuração e equipe para uma instância sob seu controle. A função verifica `source_project_id` por `auth_user_coordinator_or_creator_project_ids()` ou `is_master()` antes de ler o snapshot.

O novo `created_by` é sempre `clerk_uid()`. A função não aceita esse campo nem a identidade do projeto do cliente, não aceita listas de membros arbitrárias e não recebe as colunas copiadas no payload; ela gera o ID do projeto e seleciona o snapshot da origem dentro da mesma transação. Assim, o cliente escolhe apenas origem, nome, descrição, opção de equipe e o token opaco de retry.

Qualquer falha ao inserir equipe ou provenance aborta toda a transação. Não deve existir cleanup compensatório em `catch`, porque ele criaria um segundo caminho sujeito a falha e manteria representável o projeto órfão.

## Idempotência

`request_id`, escopado por `created_by`, é a chave de idempotência; `projects.id` continua sendo gerado pelo banco. Na primeira chamada, a RPC adquire um advisory lock transacional derivado da dupla `(clerk_uid(), request_id)`, consulta o evento, cria o projeto e grava o evento na mesma transação; a constraint `UNIQUE (created_by, request_id)` permanece como invariante independente contra colisões. Em retry após uma resposta perdida, a função encontra o evento e só devolve o `project_id` já criado quando origem registrada, nome, descrição normalizada e `included_members` correspondem à mesma solicitação; qualquer reutilização com payload diferente retorna erro genérico de conflito, sem revelar outro projeto. `copied_member_count` permite confirmar o efeito sem reler uma equipe de origem que pode ter mudado depois.

Não se procura projeto por nome e não se usa token de retry como ID de recurso. Nome não é único, e gerar outro `request_id` para a mesma submissão constitui uma solicitação nova; por isso, o formulário conserva o token original até receber resposta terminal.

Como a transação é indivisível, não há estado “projeto existe, mas membros ou audit event não”. O caminho idempotente apenas lê e devolve o resultado confirmado; ele não tenta completar etapas parciais que a transação já tornou impossíveis.

## Interface proposta

A página atual `/projects/new` passa a oferecer duas opções explícitas: “Projeto vazio” e “A partir de outro projeto”. O primeiro mantém o fluxo vigente; o segundo lista apenas projetos em que o usuário é coordenador/criador, além de todos para master, com busca por nome.

Ao escolher a origem, o formulário mostra um resumo numérico: quantidade de campos, versão do schema, provedor/modelo, modo de automação e quantidade de membros elegíveis à cópia. Nenhum documento, resposta ou atribuição aparece como copiável.

O checkbox “Copiar equipe e permissões” vem desligado e explica quais sete atributos de membro serão preservados. Antes da confirmação, a UI informa que corpus, rodadas, respostas, comparações e histórico não serão copiados.

Após sucesso, o usuário é redirecionado para Configurações › Documentos do novo projeto. O cabeçalho mostra a provenance e oferece link para a origem apenas enquanto ela continuar acessível. Se a origem foi apagada ou deixou de ser acessível, o texto histórico permanece sem link.

Erros retornam texto específico: origem inexistente/inacessível, permissão insuficiente, colisão da chave idempotente ou falha transacional. A UI não deve cair silenciosamente para criação vazia se a origem falhar.

## Plano de implementação

### Etapa 1 — contrato transacional

Adicionar migration de `project_clone_events`, RPC, RLS e testes SQL. Refatorar `createProject` para que o fluxo vazio também use uma operação atômica ou uma RPC irmã; manter o insert duplo existente deixaria o estado órfão possível fora da nova feature.

### Etapa 2 — Server Action e tipos

Criar uma action com payload tipado e retorno `{ projectId } | { error }`, sem `select("*")`. A leitura de origens deve selecionar somente `id`, `name`, versão, contagem agregada de campos e membros e respeitar limite/paginação da lista.

### Etapa 3 — UI

Adicionar o seletor de modo, fonte, resumo e checkbox opt-in na página de criação. A mutation continua por Server Action e a página de dashboard conserva um único caminho “Novo projeto”.

### Etapa 4 — observabilidade e remoção do workaround

Registrar métricas sem conteúdo do schema: sucesso/falha, duração, `include_members` e contagens copiadas. O script fechado da #155 não volta para `main`; automação futura deve chamar o mesmo contrato da aplicação, não uma cópia com service role e lista de colunas independente.

## Testes obrigatórios

### SQL e RLS

- Coordenador, criador e master conseguem clonar; pesquisador e usuário externo não conseguem.
- O chamador vira criador e coordenador mesmo quando o criador da origem é outra pessoa.
- `include_members = false` cria exatamente um membro com defaults explícitos; `true` preserva os sete atributos dos demais membros e, para o chamador já presente na origem, preserva as cinco configurações de permissão/carga enquanto força o papel de coordenador.
- Falha forçada no insert de membro ou de `project_clone_events` deixa zero linhas novas em todas as tabelas.
- Retry com o mesmo `request_id`, ator e payload devolve o mesmo projeto gerado pelo banco; reutilização do token pelo mesmo ator com payload diferente falha sem expor dados.
- Não há policy autenticada para alterar ou apagar `project_clone_events`.

### Server Action e UI

- O payload não aceita `project_id`, `created_by`, valores de schema, lista de membros ou versão fornecidos pelo navegador; `request_id` é apenas um token escopado de idempotência.
- O resumo apresenta números lidos da origem e o checkbox começa desligado.
- A lista de origem não expõe projetos em que o usuário é apenas pesquisador.
- Erro da RPC não redireciona nem cria projeto vazio.
- O fluxo vazio permanece atômico depois da refatoração.

### Integridade do snapshot

- As 14 colunas copiadas são idênticas à origem, inclusive `null`, arrays e JSONB.
- Código, campos e hash Pydantic são copiados juntos.
- O projeto começa em `0.1.0`, sem rodada atual, documentos, respostas, assignments ou entradas em `schema_change_log`.
- Editar o schema do novo projeto não altera a origem, e vice-versa.

## Gatilhos para normalizar `schemas` no futuro

A tabela `schemas` só deve ser proposta quando ao menos um destes sinais existir e for medido:

- Três ou mais projetos ativos precisam acompanhar automaticamente a mesma revisão de schema, em vez de receber snapshots independentes.
- Coordenadores precisam publicar uma versão uma vez e promover essa mesma versão para várias instâncias com estado de adoção visível.
- O custo de corrigir drift entre clones aparece em pelo menos duas ocorrências reais ou passa a exigir automação recorrente.
- Permissões sobre autoria, catálogo ou compartilhamento de schema deixam de coincidir com permissões de projeto.
- A quantidade de snapshots duplicados se torna um problema mensurável de armazenamento ou governança.

Quando esse limiar chegar, a normalização precisa separar versão imutável de schema de configuração mutável do projeto. Migrar agora criaria FK, regras de edição e estratégia de rollout sem um consumidor que precise de vínculo vivo.

## Alternativas consideradas

Uma tabela `schemas` compartilhada agora foi rejeitada por ampliar migration, RLS, versionamento e semântica de edição para resolver um caso que snapshot cobre integralmente. Copiar documentos foi rejeitado porque corpus define a instância e arrastaria assignments, respostas e decisões de deduplicação. Copiar membros por default foi rejeitado porque concede acesso a uma nova pesquisa sem gesto explícito. Reutilizar `schema_change_log` para provenance foi rejeitado porque esse log modela alteração de campo e alimenta reconstrução de versões, não relações entre projetos. Manter o script com service role foi rejeitado porque duplica a lista de colunas, ignora a identidade do usuário e não oferece atomicidade nem RLS de produto.

## Critérios de aceite da proposta futura

- Um clique produz uma instância independente com schema e configurações exatamente definidos neste documento.
- A operação é atômica e idempotente por `(created_by, request_id)`, enquanto o ID do projeto é gerado pelo banco.
- O chamador autorizado é o novo criador/coordenador; a origem não transfere ownership.
- Equipe só é copiada com opt-in e preserva todos os atributos vigentes, exceto o papel do chamador, deliberadamente elevado a coordenador.
- Nenhum dado operacional ou histórico da origem aparece no projeto novo.
- A provenance é estruturada, imutável e continua legível mesmo se a origem for apagada.
- Não existe tabela `schemas` nem vínculo vivo entre os conteúdos Pydantic dos dois projetos.
