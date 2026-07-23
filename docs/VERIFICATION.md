# Estratégia de verificação

Como este projeto usa a abundância de código para verificar o código que importa. Complementa `docs/CODE_QUALITY_TOOLING.md` (que cobre os gates estáticos e de teste): aqui o assunto é a *estratégia* — o que exige qual nível de verificação, e as práticas que previnem a família de bugs mais recorrente do produto ("codificação não salva"). Origem: diagnóstico de 2026-07-23 (o merge de deduplicação de 2026-06-23 deixou codificações completas presas como pendentes; reparos aplicados; achados de produto nas issues #519, #520 e #521).

## Princípio

Código ficou barato de gerar. A consequência não é revisar menos — é gerar muito mais código cujo único papel é verificar, em duas vias complementares:

1. **Verificação descartável, em abundância** — replays, checkers ad hoc, exploradores de hipótese, dossiês de diagnóstico. Respondem uma pergunta e morrem; nunca entram no repositório. No diagnóstico de 2026-07 foram ~15 scripts num único dia, e foi o replay descartável de `isCodingComplete` com dados de produção que decidiu a investigação.
2. **Muito mais testagem permanente, por padrão** — a suíte versionada só cresce: teste provado vermelho em todo bugfix, par de invariantes em todo bug de dado, spec E2E por fluxo sensível, rumo à cobertura total (#515). Escrever teste deixou de ser custo relevante; não escrever é que passou a ser caro.

A via descartável é o funil da permanente: o que um replay descartável provou útil é destilado em fixture e promovido a teste versionado. A atenção humana — o recurso que continua escasso — concentra-se no código crítico.

## Escala de importância do código

Classificar a mudança antes de tocá-la — e anunciar o tier na conversa/PR; a obrigação de verificação acompanha o tier.

| Tier | O que é | Obrigação de verificação |
|---|---|---|
| 1 — Crítico | Write path de codificações (`responses`, `reviews`, `field_reviews`, `assignments`), RLS/policies/RPCs, migrations, auth | Leitura humana integral do diff; teste provado vermelho; `npm run invariants` após a mudança; mutação manual dos guards novos |
| 2 — Verificação versionada | Suítes Vitest/pytest/SQL/Playwright, `scripts/invariants/` | Gerada com IA à vontade; revisão por amostragem + mutação dos guards que protegem o tier 1 |
| 3 — Produto geral | UI, componentes, formatação | Gates automáticos existentes; revisar assinaturas e contratos, não corpo |
| 4 — Verificação descartável (abundante) | Scripts locais de diagnóstico, replay, exploração de hipótese | Zero revisão; gerada em volume; proibida de ser importada pelo produto; nunca versionada |

## Práticas

Cada uma ancorada no incidente que a motivou.

1. **Discriminador escrita-vs-exibição** — primeiro passo obrigatório em relato de "não salvou": conferir no banco se as escritas do usuário chegaram, antes de caçar o write path. No PR #425 e no diagnóstico de 2026-07 a escrita nunca tinha falhado — a tela é que apresentava o status errado.
2. **Prova do vermelho** — todo teste que acompanha bugfix é demonstrado falhando antes do fix; todo teste de regressão novo (unitário ou E2E) é sabotado uma vez para provar que morde (o `coding-save.smoke` foi validado contra a sabotagem "UI reporta sucesso sem escrever"). Trocar o canal de escrita (upsert→RPC etc.) exige re-provar vermelhos todos os guards afetados — no #440, a troca deixou 4 guards vácuos sem nenhum gate reclamar.
3. **Mutação manual como juiz** — a afirmação "este guard está coberto" exige mutar o guard e ver o teste falhar (#454: mecanismo certo, propriedade errada — só a mutação revelou). Ferramenta dedicada: avaliação na #517.
4. **Teste por cópia de regra em cada fronteira** — regra duplicada entre TS client / Server Action / RPC SQL precisa de teste em cada cópia; ao caçar bug dessa família, grep pela regra, não pelo sintoma (#486/#493/#495).
5. **Replay de funções puras com dados de produção** — `npx tsx` (cwd em `frontend/` para o alias `@/`) sobre as funções reais com dados reais responde "o que a UI mostrava/decidia" por ordens de grandeza menos que E2E. Foi o discriminador decisivo do diagnóstico de 2026-07: a completude real de uma response se decide pelo replay de `isCodingComplete` (com `answer_field_hashes`), nunca por contagem crua de campos.
6. **Invariantes de banco executáveis** — `npm run invariants` (`frontend/scripts/invariants/check-invariants.ts`): asserções read-only de consistência contra o banco; verificam ESTADO, não código, então pegam drift que nenhum gate estático vê, qualquer que seja o código que o causou. Rodar após mudança em write path, após migration aplicada e ao investigar dado estranho. Duas regras: **invariantes nascem em pares** (a inversa de "concluído tem response" foi quem achou os casos reais, enquanto a direta só via sobras inertes); **FAIL vira issue no mesmo dia e nunca é silenciado no script** — mascarar invariante embute o drift como novo normal, mesma lógica que proíbe abaixar threshold de cobertura. Agendamento automático: #516.
7. **Hipóteses em paralelo** — bug com N teorias plausíveis: gerar N verificações descartáveis (uma por teoria, subagentes), cada uma devolvendo evidência; não escolher qual testar primeiro por intuição.

## Labels de revisão por PR

Todo PR recebe um label que declara o nível de revisão que ele exige, derivado do tier mais alto que o diff toca — a decisão de classificação fica visível e auditável, em vez de implícita:

| Label | Tier | O revisor deve |
|---|---|---|
| `revisão: integral` | 1 — write path, RLS/RPC, migrations, auth | Ler o diff inteiro, linha a linha; conferir a prova do vermelho do teste; rodar `npm run invariants` após merge+migration |
| `revisão: amostragem` | 2 — testes, specs, checker | Amostrar os testes e mutar os guards que protegem tier 1 (um guard mutado que não faça teste falhar reprova o PR) |
| `revisão: leve` | 3 — UI, docs, formatação | Revisar assinaturas, contratos e textos; confiar nos gates para o corpo |

Quem abre o PR aplica o label (agentes inclusive); o revisor confere se a classificação está certa antes de revisar — reclassificar para cima é sempre legítimo, para baixo exige justificativa no PR. Tier 4 não tem label: verificação descartável não vira PR.

## Regras operacionais

- **Classificar antes de tocar**: mudança em tier 1 é anunciada como tal (na conversa da sessão e no PR) antes do primeiro edit, com as obrigações correspondentes.
- **Verificação descartável vive fora do repositório**: nunca vira PR, nunca vai para `/tmp` (morre no reboot antes de servir de referência). O destino é `harness/`, ignorado pelo `.gitignore` versionado — logo o mesmo caminho vale em qualquer checkout, worktree ou agente cloud, sem depender de configuração local. O contrato completo e os gotchas de mecânica ficam num `harness/README.md` local.
- **Reparo de dado nunca é automático**: achado do checker vira proposta com preflight embutido (o comando re-mede o estado antes de escrever), aprovada explicitamente antes do `--apply`. Scripts de reparo ficam fora do repo (ver "Scripts one-off" no CLAUDE.md).
- **Spec E2E novo roda a suíte inteira** antes de declarar verde — mudança de ordem/timing pode expor hang pré-existente em spec vizinho (caso config-guard×coding-save no PR #522; o fix padrão para signOut travado em página de análise é `prepareSignOut` → `/dashboard`).
- **Subagentes geram e rodam verificação; o agente principal responde pelo veredito** — relato de sucesso de subagente não é prova; inspecionar a evidência (diff, output, asserção).
- **Mecânica de scripts avulsos** (dois gotchas recorrentes): bare imports resolvem pelo caminho do arquivo importador, não pelo cwd — o script precisa de um `node_modules` alcançável (symlink para `frontend/node_modules` resolve); e imports com alias `@/` exigem `cwd=frontend/`, porque o tsx resolve paths pelo tsconfig do cwd.

## O framework cresce a cada sessão

Ao encerrar uma sessão que tocou tier 1 ou 2, o agente **deve propor ao menos uma prática ou teste novo** que teria pego mais cedo o que a sessão enfrentou — no resumo final ou como issue. Formato: nome, o que teria detectado, custo estimado, onde viveria. O usuário aprova e vira issue.

Tipos de prática que valem proposta (cardápio inicial, com o encaixe concreto neste projeto):

1. **Testes de propriedade** (fast-check no Vitest / hypothesis no pytest) — o round-trip `generatePydanticCode → compile_pydantic → UI` é uma propriedade natural que o CLAUDE.md já exige mas nenhum teste explora por geração aleatória de schemas; idem o ponto-fixo de `dropHiddenConditionals` e a monotonicidade de `isCodingComplete`.
2. **Testes de contrato entre fronteiras** — para cada regra duplicada TS↔Server Action↔RPC SQL (#486), um teste que roda a MESMA entrada nas duas cópias e compara os resultados, em vez de testar cada cópia isoladamente.
3. **Testes de corrida** — reproduzir double-submits e corridas manual×automático (#490) com escritas concorrentes contra o banco local; a suíte dblink de `frontend/supabase/tests/` é o precedente.
4. **Golden tests de export** — snapshot determinístico do CSV/XLSX gerado a partir de fixture fixa; mudança de formato vira diff visível em vez de surpresa para o usuário.
5. **Replay-para-fixture** — quando um replay com dados de produção decidir um diagnóstico, destilar o caso em fixture anonimizada e promovê-lo a teste de regressão versionado (a via descartável alimentando a permanente).
6. **Novas invariantes de banco, em pares** — todo bug de dado gera a invariante que o teria detectado + a inversa dela.
7. **Testes de estado impossível na UI** — component tests provando que a UI não consegue exibir um estado que o servidor desmente (ex.: sucesso de submit indistinguível de conclusão, #519).
8. **Fuzzing dirigido de entrada** — CSV de upload malformado (papaparse) e código Pydantic adversarial contra a allowlist AST de `build_model_from_code` (segurança).

O cardápio não é fechado: sessões devem acrescentar tipos novos quando o incidente da vez pedir uma forma de verificação que nenhum item cobre.
