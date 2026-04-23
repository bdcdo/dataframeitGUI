# Direcionamentos pré-coordenador — q24 Justificativas (Zolgensma, 2026-04-22)

> **Status (2026-04-23):** decisões aplicadas no schema (projeto Zolgensma, versão 0.12.0 → 0.13.0).
> - **Tema A:** adotada leitura estrita (A1) — help_text foca no tópico conclusivo.
> - **Tema B:** dividida em duas perguntas por polaridade (B1) — `q24a_justificativas_favoraveis` e `q24b_justificativas_desfavoraveis`.
> - **Tema C:** condicionalidade aplicada — q24a aparece se `q21 ∈ {Sim, Sim com ressalvas}`; q24b aparece se `q21 ∈ {Sim com ressalvas, Não}`. Nenhuma aparece quando `q21 = NatJus não emitiu recomendação`.
> - **Tema D:** opção 10 unificada para "Uso de acordo com protocolo clínico do SUS / PCDT" (polaridade correspondente em cada pergunta).
> - Help_text inclui notas adicionais sobre (i) "evidência genérica vs. evidência para o grupo do paciente" (caso Matheuscadedi/NT 451549) e (ii) pareceres sem seção conclusiva clara (caso Matheuscadedi/NATJUS-Federal 0647/2025).
> - 11 dúvidas em q24 + 1 anotação reclassificada de q10 (Wangdanielwl) foram resolvidas. Respostas LLM anteriores ficaram automaticamente invalidadas via `pydantic_hash`; respostas humanas não foram migradas (ficarão sinalizadas para re-codificação).


Pergunta **q24 (Justificativas utilizadas pelo NatJus para a (não) recomendação)** foi separada do documento principal porque foi o campo que gerou mais debate na rodada: 10 comentários de 4 pesquisadores em 4 documentos distintos, mais duas referências cruzadas em notas gerais. O problema de fundo é **metodológico** e retrodepende de decisões que afetam codificações já feitas — por isso vale dedicar atenção específica.

---

## Estado atual da pergunta

### q24_justificativas_recomendacao

- **Descrição:** "Justificativas utilizadas pelo NatJus para a (não) recomendação"
- **Tipo:** `multi` (o pesquisador pode marcar mais de uma)
- **Help_text atual:**
  > "Marcar apenas aquilo que serve para fundamentar a recomendação, não as ressalvas.
  > Incluir apenas o que de fato justifica a conclusão, o que o parecer destaca como fundamental para a decisão."
- **11 opções atuais** (literais, na ordem do schema):
  1. "(Não) Há evidência segura de benefício clínico"
  2. "(Não) Há alternativa terapêutica adequada disponível"
  3. "(Riscos à) Segurança (efeitos colaterais e eventos adversos)"
  4. "(Não) possui registro na Anvisa"
  5. "Uso (não) de acordo com bula (on/off label)"
  6. "(Alto) Impacto orçamentário/custo/custo-efetividade (QALY)"
  7. "Conitec (não) recomendou tratamento"
  8. "Paciente (não) se enquadra no grupo para a qual tecnologia foi recomendada pela Conitec"
  9. "Tratamento (não) está incorporado ao SUS"
  10. "Uso (não) de acordo com protocolo clínico do SUS"
  11. "Ausência de documentos necessários para elaboração do parecer"

### q21_relatorio_recomenda (referência importante)

- **Descrição:** "Relatório recomenda o tratamento para o paciente"
- **Tipo:** `single`
- **Opções:** "Sim", "Sim, mas com ressalvas", "Não", "NatJus não emitiu recomendação"

Observação: q21 **já registra** o caso "NatJus não emitiu recomendação", o que facilita amarrar a lógica de condicionalidade para q24.

---

## Tema A — Escopo de leitura: só conclusão ou parecer inteiro?

### O problema

O help_text atual diz *"Incluir apenas o que de fato justifica a conclusão"*, mas isso é **ambíguo**: "justificar a conclusão" pode ser lido como (a) *"aparece literalmente no tópico de conclusão do parecer"* (ex: seção 3.11 das notas do NAT-JUS/SP), ou (b) *"qualquer coisa que, no parecer inteiro, sustenta a conclusão final"*. Os pesquisadores se dividiram nessa leitura, com impactos concretos em como codificaram cada documento.

### Quem defende cada lado

**Lado "só conclusão" (leitura estrita)**

- **Wangdanielwl** — consistente em três documentos:
  - NT 3672/2025 NAT-JUS/SP: *"Eu colocaria apenas 'Paciente (não) se enquadra no grupo para a qual tecnologia foi recomendada pela Conitec'. Na conclusão não há menção a evidência"*.
  - NT 451549 TRF4/RS: *"Com relação ao gabarito, acho que o correto é tirar referência ao protocolo e incluir 'Paciente (não) se enquadra no grupo para a qual tecnologia foi recomendada pela Conitec'"*.
  - NT NatJus - DF - AME tipo I: *"Considerar apenas o que está no 3.11: (Não) possui registro na Anvisa; (Não) Há evidência segura de benefício clínico; Impacto orçamentário/custo/custo-efetividade (QALY); Conitec (não) recomendou tratamento; Uso (não) de acordo com protocolo clínico do SUS"*.
- **Matheuscadedi** — manifesta pelo menos ambivalência em favor dessa leitura: *"Para a resposta eu havia considerado, somente, o tópico da 'conclusão justificada'. Nesse sentido, o tópico não citou, expressamente, a presença ou ausência de evidência segura de benefício clínico. Mantemos essa lógica ou olhamos para outras partes do parecer?"*

**Lado "parecer inteiro" (leitura ampla)**

- **Marianapuschel** (NT 3672/2025 NAT-JUS/SP): *"Acho que fala em custo-efetividade na conclusão"* — a inclusão de custo-efetividade decorre de olhar para o corpo + conclusão.
- **Matheuscadedi** (NT NatJus - DF): *"Confirmar se deve ser consultado somente o tópico conclusivo ou se o parecer como um todo"* — sinaliza que ele também tem dúvida, não é 100% "só conclusão".
- **Luizscho** (NT 3672/2025 NAT-JUS/SP): *"Posso estar muito engando, mas considerando apenas a conclusão justificada, o fato do paciente não se enquadrar no grupo para a qual a tecnologia foi recomendada que foi elemento determinante para fundamentar a decisão. Me parece que, além disso, o parecer se baseia em critérios técnicos e regulatórios."* — Luizscho tenta reconciliar: na conclusão, o central é "paciente não se enquadra"; no resto, há outros critérios.

### Casos-limite que apareceram

- **Matheuscadedi (NT 451549)**: *"existem situações em que os pareceres mencionam existir evidências gerais de benefício, mas que estes benefícios não são comprovados para o grupo em que o paciente se enquadra. Nessas hipóteses a alternativa deve ser preenchida?"*
   → Problema: o parecer cita evidência **em abstrato**, mas **não** evidência **para o grupo do paciente**. Marcar opção 1 ou não?
- **Matheuscadedi (Parecer NATJUS-Federal 0647/2025 - RJ)**: *"Esse parecer foi particularmente difícil, pois não há tópico de conclusões ou uma posição clara sobre a recomendação ou não ao uso do medicamento. Isso dificulta o mapeamento das justificativas. Assim, é difícil diferenciar o que é uma 'informação jogada' e o que é uma justificativa."*
   → Problema: em pareceres sem seção conclusiva clara, a leitura "só conclusão" não se aplica — o que fazer?
- **Naomi (NT 451549)**: *"Vi aqui e acho que a única alternativa que faltou no meu gabarito foi essa 'Uso (não) de acordo com protocolo clínico do SUS'. Dúvida leiga - protocolo clínico e PCDT são a mesma coisa?"*
   → Problema: confusão terminológica entre "protocolo clínico do SUS" (opção 10 de q24) e PCDT (que aparece em q11 se aceitarmos a mudança).

### Comentário reposicionado — Wangdanielwl originalmente em q10

No relatório original, há uma anotação do **Wangdanielwl** registrada em **q10** (Tratamento incorporado ao SUS) dizendo:

> *"Daniel: opções 1 (não foram estabelecidos estudos de segurança e eficácia para essa população), 6 (Cabe considerar o custo e a custo-efetividade do tratamento.) e 8 (O uso do medicamento fora das condições especificadas pela CONITEC — isto é, para pacientes com AME tipo 1, com mais de 6 meses de idade na data da solicitação — poderia comprometer uma parte significativa dos recursos públicos)"*

As "opções 1, 6 e 8" descritas são, palavra por palavra, o conteúdo das opções de **q24**:
- **Opção 1:** "(Não) Há evidência segura de benefício clínico"
- **Opção 6:** "(Alto) Impacto orçamentário/custo/custo-efetividade (QALY)"
- **Opção 8:** "Paciente (não) se enquadra no grupo para a qual tecnologia foi recomendada pela Conitec"

O que parece ter acontecido é que o Wangdanielwl usou o campo de anotação da q10 para justificar seu voto de **q24** naquele documento. Ou seja: para **NT 451549 TRF4/RS**, a sugestão dele é marcar as opções 1, 6 e 8 de q24 — o que conecta diretamente com o comentário dele em q24 do mesmo documento (citado acima no "lado só conclusão").

### Propostas para o Tema A

**Proposta A1 — Consagrar "só conclusão" no help_text (endossar a leitura estrita).**
- Nova redação do help_text:
  > "Marcar apenas as justificativas explicitamente usadas no tópico conclusivo do parecer (ex: seção 3.11 em notas do NAT-JUS/SP, ou o bloco equivalente em outros pareceres). Não inferir justificativas a partir do corpo geral do documento. Em pareceres sem seção conclusiva clara, anotar no campo 'nota do pesquisador' e optar por 'Não aplicável' via q21."
- **Trade-off:** reprodutibilidade alta (dois pesquisadores lendo o mesmo parecer chegam ao mesmo resultado) × perde nuances do corpo (um parecer que fundamenta no corpo mas é seco na conclusão ficaria subcodificado).
- **Impacto retroativo:** respostas codificadas com a leitura ampla precisam ser retomadas em todos os 4 documentos citados (pelo menos).

**Proposta A2 — Consagrar "parecer inteiro" no help_text (endossar a leitura ampla).**
- Nova redação:
  > "Considerar todas as justificativas que fundamentam a recomendação, mesmo que apareçam fora do tópico conclusivo. O critério é funcional: se o argumento sustenta a conclusão (mesmo que apenas implicitamente), marcar a opção correspondente."
- **Trade-off:** captura mais informação × depende de julgamento do pesquisador, então respostas variam mais entre codificadores. Comparações humanas ficam mais ruidosas.
- **Impacto retroativo:** o oposto de A1.

**Proposta A3 — Híbrida: dois níveis de peso.**
- Manter a leitura ampla, mas acrescentar uma **questão ou subcampo** tipo "qual dessas justificativas aparece no tópico conclusivo?" — capturando a hierarquia (corpo vs. conclusão) sem descartar nada.
- **Trade-off:** análise mais rica × dobra trabalho do pesquisador; exige desenho novo.
- **Conecta com Proposta B** (dividir a pergunta).

### Pergunta para você

Antes de avançar para as outras sub-questões: **qual leitura deve ser oficial?** (A1, A2 ou A3). Sugiro **A1** — é a que o Wangdanielwl e o Matheuscadedi estão defendendo com mais consistência, e é mais reprodutível para o tipo de análise empírica que esse projeto alimenta. Mas isso tem custo retroativo.

---

## Tema B — Dividir q24 em duas perguntas (proposta do Leitedesouza)

### Ponto

Leitedesouza (nota geral, ponto 4): *"Não íamos dividir essa pergunta em dois? 'Justificativas utilizadas pelo NatJus para a (não) recomendação'"*.

Como está, a pergunta mistura justificativas **pró-recomendação** e **contra-recomendação** num único multi-select (note como todas as opções começam com "(Não)..."). Na hora da análise, é possível inferir o sentido pela combinação com q21 (se q21="Sim", o "(Não)" das opções lê-se como "Há"; se q21="Não", lê-se como "Não há"), mas isso é fonte comprovada de erro.

### Três desenhos possíveis

**Proposta B1 — Dividir por polaridade.**
- q24a: *"Justificativas utilizadas pelo NatJus para **recomendar** o tratamento"* — opções sem "(Não)" na frente, formuladas positivamente.
- q24b: *"Justificativas utilizadas pelo NatJus para **não recomendar** o tratamento"* — opções com "(Não)" ou "Riscos" explícitos.
- **Trade-off:** elimina a ambiguidade da dupla leitura × codificador tem que marcar em duas listas longas.

**Proposta B2 — Dividir por escopo de leitura** (conecta com Tema A).
- q24a: *"Justificativas utilizadas no tópico conclusivo do parecer"* — lista única de justificativas, mas restrita ao que aparece explícito na conclusão.
- q24b: *"Justificativas mencionadas no corpo do parecer (fora da conclusão)"* — lista igual, mas para o corpo.
- **Trade-off:** captura a hierarquia corpo × conclusão (a "A3" no Tema A acima) × cada parecer ganha duas perguntas idênticas, aumentando o formulário.

**Proposta B3 — Manter a pergunta única mas reformular para separar polaridade e escopo em campos internos.**
- Ao marcar uma opção (ex: "Há evidência segura"), o codificador preenche dois sub-checkboxes: "aparece na conclusão?" (sim/não) e "peso: a favor / contra".
- **Trade-off:** análise rica × implementação mais complexa; depende da UI suportar bem essa estrutura.

### Pergunta para você

A divisão é desejável, mas a forma muda a análise:
- B1 resolve só a polaridade (dá pra fazer análises "NatJus recomendou vs. não recomendou" limpas).
- B2 resolve só a hierarquia conclusão × corpo (dá pra medir "argumentos na conclusão têm mais peso" empiricamente).
- B3 é mais rico, mas mais caro.

Qual dessas rotas é mais alinhada com o objetivo da pesquisa?

---

## Tema C — Condicionalidade quando não há recomendação

### Ponto

Leitedesouza (nota geral, ponto 5): *"É para preencher 'Justificativas utilizadas pelo NatJus para a (não) recomendação' se não houver decisão pelo Nat? Está como pergunta obrigatória"*.

### Minha proposta

**Proposta C1 — Tornar q24 condicional a `q21 != "NatJus não emitiu recomendação"`.**
- Quando q21 for "NatJus não emitiu recomendação", a q24 não aparece no formulário.
- Tecnicamente: usar o mecanismo de `depends_on` do schema.
- **Trade-off:** elimina o ruído de respostas forçadas em pareceres sem decisão × precisa cuidado na análise (ausência de q24 ≠ "nenhuma justificativa" — é "sem decisão").

Esse ponto é **independente** do debate sobre escopo de leitura (Tema A), então pode ser aplicado primeiro mesmo antes do resto ser resolvido.

### Pergunta para você

Aprova a condicionalidade `q24 depende de q21 ≠ "NatJus não emitiu recomendação"`?

---

## Tema D — Terminologia: "protocolo clínico do SUS" × "PCDT" (dúvida da Naomi)

### Ponto

Naomi (NT 451549 TRF4/RS): *"Dúvida leiga - protocolo clínico e PCDT são a mesma coisa?"*

A opção 10 de q24 diz *"Uso (não) de acordo com protocolo clínico do SUS"*. Se no projeto decidirmos incorporar **PCDT** em q11 (ver doc principal, Tema 3), a opção 10 de q24 fica desatualizada — ou pior, fica inconsistente com q11.

### Minha proposta

**Proposta D1 — Padronizar a sigla no schema.**
Renomear a opção 10 para: *"Uso (não) de acordo com protocolo clínico do SUS / PCDT"* (ou o que decidirmos em q11).

**Trade-off:** consistência terminológica × pode ser redundante se PCDT já foi citado em q11. Alternativa: deixar q24 como está e adicionar uma **nota metodológica de projeto** esclarecendo que *"protocolo clínico do SUS"* e *"PCDT"* são equivalentes.

### Pergunta para você

Prefere mudar a opção ou manter e esclarecer via nota?

---

## Resumo das decisões pedidas para q24

| Tema | Decisão |
|---|---|
| A. Escopo de leitura | A1 (só conclusão) / A2 (parecer inteiro) / A3 (híbrido) |
| B. Divisão da pergunta | B1 (polaridade) / B2 (conclusão × corpo) / B3 (subcampos) / manter única |
| C. Condicionalidade a q21 | sim / não |
| D. PCDT na opção 10 | renomear / manter com nota externa |

As Temas A e B são conectados: se a decisão de A for A3 (híbrido), então B2 vira a implementação natural. Se for A1 ou A2, a divisão é menos essencial — dá pra fazer só C e D.

---

## Impacto retroativo

**Se A1 ou A2 muda o help_text**, isso gera um novo `pydantic_hash` para q24 e **invalida automaticamente** as respostas LLM (elas são marcadas como stale e re-executadas). Respostas humanas não são invalidadas automaticamente, mas a divergência entre o que foi codificado e o novo critério fica visível na UI (via `answer_field_hashes`).

**Se B divide a pergunta**, as respostas antigas não se encaixam automaticamente nas duas novas perguntas. Precisamos decidir:
- Marcar tudo como stale e pedir re-codificação.
- Migrar automaticamente (ex: em B1, mapear opções "pro-conclusão" e "contra" via heurística a partir de q21).

Em qualquer dos cenários, vale alinhar com o coordenador **antes** de aplicar, porque o custo de re-codificação recai em pesquisadores ativos.

---

Quando você tiver respostas para A, B, C e D, eu monto a mudança no schema (bump de versão minor ou major dependendo do peso das mudanças), rodo `apply-decisions.ts` em dry-run, confirmo contigo, e aplico.
