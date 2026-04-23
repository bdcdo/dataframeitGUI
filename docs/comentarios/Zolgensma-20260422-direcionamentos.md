# Direcionamentos pré-coordenador — Zolgensma (2026-04-22)

## Tema 1 — Categoria "Não informado / Não aplicável" e condicionalidade quando não há recomendação

Este é o maior bloco. Aparece em **cinco lugares diferentes** e o núcleo é o mesmo: hoje várias perguntas têm uma opção-escape ("Não informado") que está sendo usada para cenários em que, na verdade, (a) a informação **tem que estar explícita** (caso contrário a resposta é "não"), ou (b) a pergunta simplesmente **não se aplica** (ex: NatJus nem emitiu recomendação).

### Pontos agrupados

- **q9 Indicação conforme Anvisa** — Wangdanielwl (anotação em NT 3672/2025 NAT-JUS/SP): *"Tirar não informado, ou foi explicitada ou nao foi"*.	
- **q9 (comentário originalmente lançado em q2)** — Wangdanielwl, ainda em NT 3672/2025 NAT-JUS/SP, deixou também a anotação *"Não fala se foi registrado para aquela condição"*. O registro ficou no campo da q2 (id da NT), mas o conteúdo é sobre q9: ele observou que o parecer não esclarece se o medicamento tem registro Anvisa **para aquela condição específica**. Reforça o ponto de que "Não informado" está virando categoria-escape em casos em que o parecer omite a especificação.
- **q20 Metodologia de evidência** — Wangdanielwl (anotação em Parecer NATJUS-Federal 0647/2025 - RJ): *"Não se aplica porque não houve recomendação"*.
- **q11 Pedido conforme critérios SUS** — Leitedesouza (nota geral, ponto 1): *"Se não foi incorporado ao sus, responde não? Acredito que a pergunta poderia ser opcional."*
- **q24 (nota geral Leitedesouza, ponto 5)** — *"É para preencher 'Justificativas utilizadas pelo NatJus para a (não) recomendação' se não houver decisão pelo Nat? Está como pergunta obrigatória"*. (Este aspecto é mencionado aqui porque é o mesmo padrão, mas o debate central sobre q24 está no doc separado.)
- **q6 Data de nascimento do paciente** — Marianapuschel (dúvida): *"Acho que se a gente precisa padronizar o NI, não fala. Podia ficar no comentário da pergunta até terminarmos"*. É um pedido de política transversal de "NI = não identificável", que afeta potencialmente todas as perguntas com essa opção.

### Estado atual das perguntas citadas

**q9_indicacao_conforme_anvisa**
- **Descrição:** "Indicação conforme registro na ANVISA"
- **Help_text:** — (não tem)
- **Opções** (`single`): "Sim", "Não", "Não informado"

**q20_metodologia_evidencia**
- **Descrição:** "A metodologia para o levantamento de evidência clínica foi explicitada?"
- **Help_text:** "Como o próprio NatJus indicou que coletou e analisou as evidências sobre a tecnologia avaliada"
- **Opções** (`single`): "Sim", "Não", "Não houve levantamento de evidência (não foram citados estudos científicos)", "Não informado"

**q11_pedido_criterios_sus**
- **Descrição:** "Pedido para uso de acordo com os critérios para incorporação ao SUS"
- **Help_text:** — (não tem)
- **Opções** (`single`): "Sim", "Não", "Não informado"

**q21_relatorio_recomenda** (referência para condicionalidade)
- **Descrição:** "Relatório recomenda o tratamento para o paciente"
- **Opções** (`single`): "Sim", "Sim, mas com ressalvas", "Não", "NatJus não emitiu recomendação"
- Observação importante: já existe o conceito "NatJus não emitiu recomendação" nessa pergunta. Ele pode servir de **gatilho canônico** para condicionar q11/q20/q24.

**q6_data_nascimento_paciente**
- **Descrição:** "Data de nascimento do paciente"
- **Tipo:** `date`, sem help_text, sem opções especiais.
- (O "NI" que a Marianapuschel menciona é a opção `"Não identificável"` que aparece em outras perguntas do tipo `text`, como q2, q3 e q22. A q6 é data, então "NI" aqui teria outro tratamento.)

### Minhas propostas

1. **Remover "Não informado" de q9.** As opções ficam apenas "Sim" e "Não". A lógica do Wangdanielwl ("ou foi explicitada ou não foi") é forte: se o parecer não indica conforme/não conforme ANVISA, a resposta é "Não" (não foi conforme explicitado). **Trade-off:** força o pesquisador em casos genuinamente ambíguos × elimina a categoria-escape que estava sendo usada para "prefiro não decidir". **Impacto retroativo:** respostas atuais marcadas "Não informado" precisam ser retomadas — são ~N casos (se você quiser, eu levanto o número exato antes de aplicar).

2. **Adicionar opção "Não aplicável" em q20.** O Wangdanielwl aponta que, quando o parecer nem chega a emitir recomendação, a pergunta sobre metodologia de evidência perde sentido. **Trade-off:** "Não aplicável" é uma categoria mais honesta que "Não informado" nesse cenário × adiciona complexidade para o codificador decidir entre os quatro ou cinco valores. **Alternativa mais clean:** tornar q20 **condicional** a `q21 != "NatJus não emitiu recomendação"` (ou seja, só aparece quando houve recomendação). Se a pergunta não aparece, não precisa de opção "Não aplicável".

3. **Tornar q11 condicional a q10.** Só perguntar "pedido conforme critérios SUS" quando `q10_tratamento_incorporado_sus` for "Sim" (ou similar). Quando o tratamento nem é incorporado, a pergunta vira vazia mesmo. **Trade-off:** mais elegante × perde-se o registro de "o pedido seguia alguma outra lógica de incorporação?" em casos raros.

4. **Tornar q24 condicional a q21** — faz parte do doc separado de q24, mas menciono aqui para você ver que o padrão é o mesmo: quando `q21 == "NatJus não emitiu recomendação"`, q24 não faz sentido.

5. **Política geral de "NI".** Acho que vale uma decisão metodológica de projeto que valha para **todas as perguntas com `"Não identificável"` como opção** (hoje: q2, q3, q22). Opções que enxergo:
   - (a) "NI" só quando o dado existe no parecer mas está ilegível/ininteligível (ex: campo rasurado, parcial).
   - (b) "NI" sempre que o pesquisador não consegue extrair o dado (seja porque não está, seja porque está confuso).
   - (c) Exige distinção entre "Não consta" e "Não identificável" em perguntas de texto — aí provavelmente adicionamos uma opção nova ("Não consta no parecer").

### Perguntas para você

- Aprova remover "Não informado" de q9? O que fazemos com respostas passadas?
- Prefere **opção "Não aplicável" em q20** ou **tornar q20 condicional a q21 ≠ sem recomendação**? (Eu voto na segunda, mais limpa.)
- Aprova tornar q11 condicional a q10?
- Qual das três leituras de "NI" é a oficial? Precisa virar uma nota metodológica no topo do projeto?

---

## Tema 2 — Distinção "caso geral do tratamento" vs. "caso específico do paciente"

Duas perguntas têm o mesmo problema estrutural: elas coletam uma resposta binária, mas o parecer pode dizer algo diferente no plano geral (o tratamento existe / está incorporado) e no plano do caso individual (não para este paciente específico). Hoje não há como registrar os dois planos.

### Pontos agrupados

- **q3 Número do processo judicial** — Wangdanielwl (anotação em NT 451549 - TRF4/RS): *"Daniel: marca sim aqui e informa na questão seguinte que não para o caso do paciente"*. É uma orientação de codificação, mas deixa claro que a estrutura atual não distingue "há processo vinculado ao parecer mas não é o do paciente" de "há processo do paciente".
- **q10 Tratamento incorporado ao SUS** — Leitedesouza (review em NT 451549 - TRF4/RS, 2026-03-27, veredito "Sim"): *"O parecer fala não, mas entendo que está, só não para o caso do paciente. Como lidamos com isso?"*

### Estado atual

**q3_numero_processo_judicial**
- **Descrição:** "Número processo judicial"
- **Tipo:** `text` (captura o número)
- **Help_text:** — (não tem)
- **Opções especiais:** "Não identificável"

**q10_tratamento_incorporado_sus**
- **Descrição:** "Tratamento incorporado ao SUS"
- **Help_text:** — (não tem)
- **Opções** (`single`): "Sim", "Não", "Não informado"

### Minhas propostas

1. **Para q3 — acrescentar opção especial.** Como você sugeriu: adicionar uma opção ao nível de `options` tipo *"Há apenas número de processo não relacionado ao paciente"*. O campo continua sendo `text`, mas essa opção serve de sinalizador quando se marca sem preencher o número. **Trade-off:** pesquisador ganha categoria precisa × adiciona a responsabilidade de lembrar quando usar ("mas e se for parcialmente relacionado?"). **Alternativa:** deixar como está e adicionar help_text: *"Se houver processo mencionado no parecer que não é do paciente em análise, informar como 'Há apenas nº de processo não relacionado ao paciente'."* — mas sem a opção no enum fica vago.

2. **Para q10 — dois desenhos possíveis.**
   - **(a) Dividir em duas perguntas.** Uma: *"Tratamento incorporado ao SUS (em geral)?"* — Sim/Não. Outra: *"Incorporado para o quadro clínico do paciente?"* — Sim/Não/Não aplicável.
     - **Trade-off:** capta com precisão o caso do Leitedesouza. Aumenta o formulário em uma pergunta. Torna análise cruzada mais rica (dá pra cruzar "incorporado em geral mas não para o paciente" × veredito final).
   - **(b) Acrescentar opção à pergunta atual.** "Sim", "Não", "Sim, mas não para o caso do paciente", "Não informado".
     - **Trade-off:** não quebra a estrutura da pergunta. Categoria "sim mas não para o caso" pode virar bucket guarda-chuva (vai ter casos genuinamente sim e casos onde é "sim na teoria"). Comparações entre respostas ficam mais fracas (um pesquisador marca "Sim", outro "Sim mas não para o caso" para o mesmo parecer — isso aparece como divergência).

### Perguntas para você

- Para q3, aprova a nova opção *"Há apenas número de processo não relacionado ao paciente"*? Outra redação que prefira?
- Para q10, **(a)** dividir em duas perguntas ou **(b)** acrescentar opção?
- Se for (a), seria boa hora de pensar se **q11** (critérios SUS) deve se referir à dimensão geral ou à específica do paciente.

---

## Tema 3 — Ajuste de redação com PCDT (q11)

Só um ponto nesse tema, mas conecta com Tema 1 (condicionalidade).

### Ponto

**q11** — Leitedesouza (review em NT 451549 - TRF4/RS, 2026-03-27, veredito "Não"): *"Mudaria a redação da pergunta para incluir PDCT"*. Traduzindo: PCDT (Protocolo Clínico e Diretrizes Terapêuticas) é o documento do SUS que rege o uso de tecnologias incorporadas. Para uma parte dos pareceres, o que existe é um PCDT específico — não uma "incorporação" genérica.

### Estado atual

**q11_pedido_criterios_sus**
- **Descrição:** "Pedido para uso de acordo com os critérios para incorporação ao SUS"
- **Help_text:** — (não tem)
- **Opções** (`single`): "Sim", "Não", "Não informado"

### Minha proposta

Mudar a descrição para algo como:

> "Pedido para uso de acordo com os critérios para incorporação ao SUS / PCDT"

ou, mais explícito:

> "Pedido para uso conforme critérios de incorporação ao SUS ou PCDT (Protocolo Clínico e Diretrizes Terapêuticas)"

**Trade-off:** segunda opção é mais didática, mas pesada; primeira é seca mas depende do pesquisador saber o que é PCDT (provavelmente já sabe). Em ambos os casos, pode-se **adicionar help_text** explicando: *"Marcar 'Sim' se o pedido seguir tanto os critérios de incorporação do SUS (via Conitec) quanto eventuais PCDT específicos para a patologia."*

Junto disso, cabe discutir a condicionalidade já mencionada no Tema 1 (q11 só aparece quando `q10 != Não` ou similar).

### Perguntas para você

- Qual redação prefere?
- Adicionar help_text explicando PCDT?
- Aprova a condicionalidade `q11 depende de q10`?

---

## Tema 4 — Escopo da pergunta q20 ("incluir ANS" — ambíguo)

### Ponto

**q20** — Wangdanielwl (anotação em NT 3672/2025 NAT-JUS/SP): *"Considerar apenas a justificação da conclusão: mudar a questão para incluir ANS"*.

Aqui eu genuinamente não sei o que ele quis dizer. Há duas leituras plausíveis:

- **(a)** A q20 trata de metodologia de evidência. A ANS (Agência Nacional de Saúde Suplementar) também emite notas técnicas sobre tecnologias — talvez o Wangdanielwl esteja sugerindo que a pergunta não é só sobre NatJus, mas também sobre pareceres de ANS (expandindo escopo).
- **(b)** "Mudar a questão para incluir ANS" pode ser uma referência ambígua a limitar o escopo textual (tipo "na parte da Análise de Síntese"? — forçado, mas possível), ou a incluir alguma sigla nova no rol.

### Estado atual

**q20_metodologia_evidencia** — já citado no Tema 1. Reproduzindo:
- **Descrição:** "A metodologia para o levantamento de evidência clínica foi explicitada?"
- **Help_text:** "Como o próprio NatJus indicou que coletou e analisou as evidências sobre a tecnologia avaliada"
- **Opções** (`single`): "Sim", "Não", "Não houve levantamento de evidência (não foram citados estudos científicos)", "Não informado"

### Pergunta para você (ou para o Wangdanielwl diretamente)

- O que ele quis dizer com "incluir ANS"? Vale pedir clarificação antes de mexer.
- Se for leitura (a) — estender para pareceres de ANS —, o escopo do projeto vai além de NatJus mesmo? Isso é uma mudança de **escopo da pesquisa**, não só de redação da pergunta.

---

## Tema 5 — Perguntas q15 e q16 (outras agências e outros países)

### Ponto

Leitedesouza (nota geral, ponto 2): *"'Menção a avaliação de tecnologia em outros países, especificar quais' e 'Menção a registro em outras agências, especificar quais'. Acredito que ambas as perguntas poderiam ser respondidas com regex"*.

### Estado atual

**q15_registro_outras_agencias**

- **Descrição:** "Menção a registro em outras agências, especificar quais"
- **Tipo:** `multi`, com `allow_other: true`
- **Opções:** "FDA (EUA)", "EMA (União Europeia)", "MHRA (Reino Unido)", "PMDA (Japão)", "Não houve"

**q16_avaliacao_tecnologia_outros_paises**
- **Descrição:** "Menção a avaliação de tecnologia em outros países, especificar quais"
- **Tipo:** `multi`, com `allow_other: true`
- **Opções:** "NICE (Inglaterra)", "CADTH (Canadá)", "PBAC (Austrália)", "IQWiG (Alemanha)", "HAS (França)", "Não houve"

### Observação importante

O schema atual **já não é texto livre** — é `multi` com as principais agências listadas e `allow_other: true` para quem não estiver na lista. Então a sugestão de "responder via regex" talvez venha da expectativa de que essas perguntas sejam de texto livre, o que não é o caso hoje (talvez o Leitedesouza tenha codificado numa versão antiga do schema onde era `text`? Pelo log do banco, houve mudanças de opções dessas perguntas em 2026-04-10).

### Minhas propostas

1. **Manter como está** — o desenho atual com lista fechada + `allow_other` já cumpre o papel que "regex" cumpriria (padronizar entradas frequentes). **Resposta sugerida ao Leitedesouza:** *"Já migramos para multi-select com as principais agências — pode ajudar checar se na sua última codificação você viu o formato de texto livre, pois nesse caso o schema estava atrasado."*

2. **Se o ponto dele é "a lista está incompleta"** — aí vale perguntar: quais agências ele viu aparecerem no corpus que ainda não estão nas opções? Adicionamos.

3. **Se o ponto é "queria validação automática do texto livre em `allow_other`"** — aí é uma feature de aplicação, não de schema. Pode virar follow-up.

### Perguntas para você

- Confirma que o design atual (multi + allow_other) é o que queremos?
- Conhece agência/país que não está no rol e aparece com frequência?

---

## Tema 6 — "Não coletamos mais outras opções de tratamento?" (Leitedesouza ponto 3)

### Ponto

Leitedesouza (nota geral, ponto 3): *"Não vamos mais coletar se há outras opções de tratamento?"*

Interpretação: parece sugerir que em algum momento havia uma pergunta sobre alternativas terapêuticas disponíveis ao paciente e que hoje sumiu.

### O que achei no histórico

Consultei o `schema_change_log` do projeto: **nenhum campo foi removido** ao longo das 19 alterações registradas desde 2026-04-01. Todas as mudanças foram em campos existentes (ajuste de instruções, opções ou descrição). Ou seja, **não há uma pergunta "outras opções de tratamento" que tenha sido excluída deste projeto**.

### Três possibilidades

1. **O Leitedesouza está pensando em outro projeto.** Pode ser confusão com outro estudo.
2. **Ele está propondo incluir essa pergunta.** Nesse caso, a redação deveria ser algo tipo: *"O parecer menciona outras opções terapêuticas disponíveis para a condição do paciente?"* e, se sim, quais.
3. **Ele está se referindo a q24 (justificativas)**, que tem a opção "(Não) Há alternativa terapêutica adequada disponível". A alternativa é **citada como justificativa**, não codificada separadamente.

### Minhas propostas

- Responder ao Leitedesouza pedindo esclarecimento antes de mudar algo.
- Se for (2), considerar adicionar uma pergunta nova — mas isso é uma mudança maior, que impacta o gabarito e a paridade com codificações já feitas. Precisa decisão sua.
- Se for (3), explicar que a alternativa terapêutica está capturada em q24.

### Pergunta para você

- Acha que vale uma pergunta nova sobre alternativas de tratamento, ou a informação já está suficientemente coberta em q24?

---

## Resumo rápido das decisões pedidas

| Tema | Decisão | Complexidade |
|---|---|---|
| 1. q9: remover "Não informado" | sim/não | baixa, mas impacta retroativo |
| 1. q20: "Não aplicável" ou condicional a q21 | escolha entre duas | baixa |
| 1. q11: condicional a q10 | sim/não | baixa |
| 1. Política de "NI" | escolher entre (a)(b)(c) | média (decisão transversal) |
| 2. q3: adicionar opção | aprovar/ajustar | baixa |
| 2. q10: dividir em duas ou acrescentar opção | escolher entre (a)(b) | **alta** (muda estrutura) |
| 3. q11 PCDT: redação | escolher entre duas | baixa |
| 4. q20 "incluir ANS" | desambiguar com Wangdanielwl | depende do que ele quis dizer |
| 5. q15/q16 "regex" | confirmar que o design atual basta | baixa |
| 6. Alternativas de tratamento | pergunta nova, ou não | média |

---

## Comentários já fechados offline (só registro)

Esses 3 blocos não precisam da sua revisão — a ação é apenas fechar o ciclo:

1. **q14 (review do Leitedesouza "Não é experimental" + 4 dúvidas de pesquisadores + review "Não há menção" do Wangdanielwl)** — o help_text de q14 já é *"Marcar 'não é experimental' apenas se isso for dito expressamente."* — exatamente a regra que os 4 pesquisadores defenderam nos comentários. O review antigo do Leitedesouza foi aplicação incorreta da regra, não problema de schema. Fechar todos como rejeitar, mantendo a regra.
2. **q22 (dúvida da Naomi sobre padronizar reescrita)** — marcado pelo próprio usuário no relatório: "Ignorar e resolver".
3. **Nota geral da Naomi sobre dificuldade em identificar a recomendação do NatJus** — marcado pelo próprio usuário: "Ignorar e resolver".

> A anotação do Wangdanielwl originalmente lançada em q2 ("Não fala se foi registrado para aquela condição") foi reposicionada para o Tema 1 (debate de q9) acima — é sobre registro do medicamento para a condição específica, não sobre o id da NT.

---

Quando você quiser responder, pode ser direto aqui por cima (marcando escolhas) ou em reunião. Depois de definirmos, a aplicação no schema é automática com os scripts existentes — bumpa versão, marca as codificações LLM antigas como stale e re-avalia o que for necessário.

**Próximo doc:** `Zolgensma-20260422-q24-justificativas.md` (debate metodológico da q24 em separado).
