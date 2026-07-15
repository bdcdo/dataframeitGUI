# Especificação do projeto exemplo

**Status:** proposta para a [issue #158](https://github.com/bdcdo/dataframeitGUI/issues/158); nenhum dado é provisionado por este documento.

## Objetivo

O projeto exemplo deve demonstrar o ciclo principal do dataframeitGUI com um conjunto pequeno, determinístico e descartável: configurar um schema Pydantic, importar documentos, distribuir codificações, produzir divergência entre 2 pesquisadores, revisar a comparação, registrar comentário e exportar o resultado. A fixture não depende de dados pessoais, de fonte externa ou de uma chamada paga de LLM.

A primeira versão contém exatamente 1 projeto, 8 documentos sintéticos, 4 membros descartáveis e 16 assignments de codificação. Os textos descrevem atos do “Município de Aurora do Sul”, localidade expressamente fictícia, e não reproduzem legislação, nomes, e-mails ou fatos reais.

## Identidade da fixture

| Propriedade | Valor canônico |
| --- | --- |
| Nome | `Projeto exemplo — políticas urbanas sintéticas` |
| UUID do projeto | `15800000-0000-4000-8000-000000000001` |
| Marcador de versão | `[fixture:example-project:v1]` na descrição |
| Modo de automação | `compare_humans` |
| Respostas mínimas para comparação | `2` |
| Incluir LLM na comparação | `false` |
| Documento fora do escopo | habilitado |
| Estratégia de rodada | `manual` |

O UUID e o marcador formam a identidade conjunta da fixture. Uma execução deve abortar se o UUID já existir sem o marcador exato; ela não pode assumir que qualquer projeto com nome parecido é descartável.

## Corpus canônico

O artefato de implementação deve materializar o bloco abaixo em `docs/examples/fixtures/example-project-documents.csv`, preservando as 4 colunas e as 8 linhas nesta ordem. `source_group` é metadado auxiliar mantido na exportação; `external_id`, `title` e `text` são mapeados para os campos correspondentes do upload.

```csv
external_id,title,text,source_group
E158-001,Programa-piloto de ônibus elétricos,"A Portaria nº 1 do Município fictício de Aurora do Sul autoriza, a partir de 15/03/2026, um piloto com dois ônibus elétricos. A Secretaria de Mobilidade deverá publicar o plano de operação em até 90 dias.",mobilidade
E158-002,Coleta seletiva em prédios públicos,"A Resolução nº 2 do Município fictício de Aurora do Sul obriga todos os prédios públicos a separar papel, plástico, metal e vidro a partir de 01/04/2026. Cada unidade deverá instalar os coletores em até 60 dias.",residuos
E158-003,Campanha de economia de energia,"O Comunicado nº 3 do Município fictício de Aurora do Sul informa que haverá uma campanha educativa sobre economia de energia. O texto não cria obrigação, não fixa prazo e não informa data de vigência.",energia
E158-004,Redução do consumo de água,"O Decreto nº 4 do Município fictício de Aurora do Sul entra em vigor em 01/05/2026 e determina redução de 10% no consumo de água dos órgãos municipais até 31/12/2026.",agua
E158-005,Conselho climático municipal,"A Lei nº 5 do Município fictício de Aurora do Sul entra em vigor em 10/05/2026 e cria um conselho climático com representantes do poder público e da sociedade civil. A primeira reunião deverá ocorrer em até 45 dias.",participacao
E158-006,Revogação do piloto de ônibus,"A Portaria nº 6 do Município fictício de Aurora do Sul entra em vigor em 20/05/2026 e revoga integralmente a Portaria nº 1, sem estabelecer providência ou prazo adicional.",mobilidade
E158-007,Energia solar em terminais,"O Decreto nº 7 do Município fictício de Aurora do Sul autoriza, a partir de 01/06/2026, a instalação de painéis solares em terminais de ônibus. O estudo técnico deverá ser concluído em até 120 dias.",energia_mobilidade
E158-008,Manutenção de elevadores,"O Comunicado interno nº 8 do Município fictício de Aurora do Sul informa a manutenção preventiva dos elevadores do edifício administrativo em 12/06/2026. O assunto não trata de política urbana ambiental.",controle_fora_escopo
```

Os textos são a fonte única dos fatos codificáveis. O projeto não deve buscar, inferir ou enriquecer informações externas.

## Schema Pydantic canônico

O código abaixo é a fonte de verdade do schema da fixture e deve passar pelo round-trip `pydantic_code → compile_pydantic → PydanticField[]`. Ele contém 7 campos: 3 categóricos, 1 data, 1 campo binário, 1 campo textual condicional e 1 síntese textual.

```python
from pydantic import BaseModel, Field
from typing import Literal, Optional


class Analysis(BaseModel):
    tipo_ato: Literal["Lei", "Decreto", "Portaria", "Resolução", "Comunicado"] = Field(description="Tipo do ato identificado no documento")
    areas: list[Literal["Mobilidade", "Resíduos", "Energia", "Água", "Participação social"]] = Field(description="Áreas de política pública tratadas de forma substantiva")
    efeito: Literal["Cria obrigação", "Autoriza ação", "Revoga regra", "Somente informa"] = Field(description="Principal efeito normativo ou informativo do documento")
    data_vigencia: str = Field(description="Data em que o ato entra em vigor. Formato: DD/MM/AAAA (use XX para partes desconhecidas). Caso não seja possível informar a data, usar um dos seguintes valores: \"Não identificável\"", json_schema_extra={"field_type": "date", "options": ["Não identificável"]})
    tem_prazo: Literal["Sim", "Não"] = Field(description="Indica se o documento fixa prazo para uma providência")
    prazo: Optional[str] = Field(default=None, description="Prazo e providência associada, com unidade e termo final quando houver", json_schema_extra={"condition": {"field": "tem_prazo", "equals": "Sim"}})
    sintese: str = Field(description="Síntese objetiva do documento em uma frase, sem acrescentar informação externa")
```

O prompt da fixture deve conter o placeholder obrigatório `{texto}` e restringir a análise ao corpus:

```text
Analise exclusivamente o documento abaixo. Não use conhecimento externo nem complete informações ausentes. Classifique o tipo do ato, as áreas tratadas, o principal efeito, a data de vigência e a existência de prazo. Quando houver prazo, identifique a providência correspondente. Termine com uma síntese factual de uma frase.

Documento:
{texto}
```

## Gabarito mínimo

O gabarito serve para verificar importação, schema e codificação; `prazo` e `sintese` permanecem textuais e podem variar sem alterar a classificação. O documento `E158-008` deve ser marcado como fora do escopo antes da codificação.

| Documento | `tipo_ato` | `areas` | `efeito` | `data_vigencia` | `tem_prazo` |
| --- | --- | --- | --- | --- | --- |
| E158-001 | Portaria | Mobilidade | Autoriza ação | 15/03/2026 | Sim |
| E158-002 | Resolução | Resíduos | Cria obrigação | 01/04/2026 | Sim |
| E158-003 | Comunicado | Energia | Somente informa | Não identificável | Não |
| E158-004 | Decreto | Água | Cria obrigação | 01/05/2026 | Sim |
| E158-005 | Lei | Participação social | Cria obrigação | 10/05/2026 | Sim |
| E158-006 | Portaria | Mobilidade | Revoga regra | 20/05/2026 | Não |
| E158-007 | Decreto | Energia; Mobilidade | Autoriza ação | 01/06/2026 | Sim |
| E158-008 | fora do escopo | fora do escopo | fora do escopo | fora do escopo | fora do escopo |

## Papéis e assignments

O provisionamento recebe 4 UUIDs de profiles locais já existentes; ele não cria conta, senha, sessão Clerk ou credencial. Os e-mails abaixo são rótulos documentais e devem ser substituídos por contas descartáveis do ambiente local.

| Alias | Papel | Flags | Uso |
| --- | --- | --- | --- |
| `example-coordinator@example.test` | coordenador | `can_resolve=true` | Configura schema, decide fora de escopo, acompanha e exporta. |
| `example-researcher-a@example.test` | pesquisador | todas `false` | Recebe 8 codificações. |
| `example-researcher-b@example.test` | pesquisador | todas `false` | Recebe as mesmas 8 codificações para produzir 2 respostas por documento. |
| `example-reviewer@example.test` | pesquisador | `can_compare=true`; demais `false` | Recebe comparações automáticas quando as 2 respostas divergem. |

O estado inicial contém 16 linhas `assignments`: 8 documentos × 2 pesquisadores, todas com `type='codificacao'` e `status='pendente'`. O revisor não recebe codificação inicial. O documento de controle continua atribuído para que o fluxo de pedido e decisão de fora do escopo possa ser demonstrado por um pesquisador e pelo coordenador.

## Fluxos demonstrados

1. **Configuração:** abrir o projeto, conferir os 7 campos compilados e o modo `compare_humans` com mínimo de 2 respostas.
2. **Documentos:** conferir 8 documentos e a preservação de `source_group` como metadado original.
3. **Codificação convergente:** A e B aplicam o gabarito a `E158-001`; nenhuma comparação é criada quando as respostas são iguais.
4. **Codificação divergente:** A aplica `areas=["Energia", "Mobilidade"]` a `E158-007` e B aplica somente `areas=["Energia"]`; após 2 conclusões, o revisor recebe 1 comparação.
5. **Fora do escopo:** A solicita exclusão de `E158-008`; o coordenador aceita e o documento deixa o conjunto ativo sem ser apagado.
6. **Comentário:** B abre 1 comentário em `E158-004`; o coordenador responde ou resolve, preservando o histórico.
7. **Exportação:** o coordenador exporta CSV ou XLSX e verifica `external_id`, texto, `source_group`, respostas e situação de revisão.
8. **LLM opcional:** somente em ambiente local com provedor configurado pelo operador; a fixture não contém chave, não exige essa etapa e seu aceite não depende dela.

## Provisionamento local opt-in

A implementação posterior deve expor um comando explícito, por exemplo `npm run example:provision`, desabilitado por default e condicionado a `EXAMPLE_PROJECT_ENABLED=1`. O comando recebe `EXAMPLE_COORDINATOR_PROFILE_ID`, `EXAMPLE_RESEARCHER_A_PROFILE_ID`, `EXAMPLE_RESEARCHER_B_PROFILE_ID` e `EXAMPLE_REVIEWER_PROFILE_ID`; todos devem existir em `profiles` antes da execução.

Antes de qualquer escrita, o provisionador deve validar que a URL do Supabase aponta para `localhost`, `127.0.0.1` ou `::1`; conferir o UUID e o marcador da fixture; mostrar as contagens planejadas; e exigir confirmação explícita. URL remota, variável ausente, profile inexistente ou colisão de identidade encerra o comando sem escrita.

Projeto, configuração, documentos, memberships e assignments devem ser gravados numa única transação. A execução inicial cria exatamente as contagens desta especificação. Uma reexecução sem `--replace` não modifica nada e informa que a fixture já existe; `--replace` só pode remover e recriar o projeto quando UUID e marcador coincidirem.

O provisionador usa somente credenciais locais obtidas no momento da execução. Nenhuma service key, senha, cookie, JWT, e-mail real ou identificador de produção é versionado. A fixture não integra `supabase db reset` nem um seed automático, pois ambos tornariam a criação implícita.

## Limpeza

A implementação posterior também deve expor um comando explícito de limpeza, por exemplo `npm run example:cleanup`, com os mesmos guards de host, variável opt-in, UUID e marcador. Esse comando futuro apaga somente o projeto `15800000-0000-4000-8000-000000000001`; as cascatas do schema removem seus dados dependentes. Profiles, contas Clerk e qualquer outro projeto permanecem intactos.

Após a limpeza, a verificação deve contar 0 linha para o UUID em `projects`, `documents`, `project_members` e `assignments`. Falha parcial deve abortar a transação e preservar o estado anterior.

## Critérios de aceite

- O provisionamento local cria 1 projeto, 8 documentos, 4 memberships e 16 assignments, com os valores canônicos acima.
- O schema compila em 7 campos e sobrevive ao round-trip sem perda de tipo, opções, data ou condição.
- Os 8 `external_id` e as 8 linhas originais do CSV permanecem disponíveis na exportação.
- Duas codificações iguais não criam comparação; a divergência definida em `E158-007` cria exatamente 1 comparação para o revisor elegível.
- `E158-008` percorre o fluxo de fora do escopo sem hard delete.
- Provisionamento e limpeza recusam qualquer Supabase remoto e não criam nem armazenam credenciais.
- A limpeza deixa 0 linha da fixture nas 4 tabelas verificadas e não altera profiles ou outros projetos.
