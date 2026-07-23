# Estratégia de verificação

Como este projeto usa código descartável para verificar o código que importa. Complementa `docs/CODE_QUALITY_TOOLING.md` (que cobre os gates estáticos e de teste): aqui o assunto é a *estratégia* — o que exige qual nível de verificação, e as práticas que previnem a família de bugs mais recorrente do produto ("codificação não salva"). Origem: diagnóstico de 2026-07-23 (o merge de deduplicação de 2026-06-23 deixou codificações completas presas como pendentes; reparos aplicados; achados de produto nas issues #519, #520 e #521).

Princípio: código de verificação é barato de gerar — o que é caro e escasso é atenção humana, que se concentra no código crítico. Verificação descartável (replays, checkers ad hoc, exploradores de hipótese) deve ser gerada em abundância e morrer fora do repositório; para o repositório vai só a correção de causa raiz e o teste que a prova.

## Escala de importância do código

Classificar a mudança antes de tocá-la; a obrigação de verificação acompanha o tier.

| Tier | O que é | Obrigação de verificação |
|---|---|---|
| 1 — Crítico | Write path de codificações (`responses`, `reviews`, `field_reviews`, `assignments`), RLS/policies/RPCs, migrations, auth | Leitura humana integral do diff; teste provado vermelho; `npm run invariants` após a mudança; mutação manual dos guards novos |
| 2 — Verificação versionada | Suítes Vitest/pytest/SQL/Playwright, `scripts/invariants/` | Gerada com IA à vontade; revisão por amostragem + mutação dos guards que protegem o tier 1 |
| 3 — Produto geral | UI, componentes, formatação | Gates automáticos existentes; revisar assinaturas e contratos, não corpo |
| 4 — Descartável | Scripts locais de diagnóstico/reparo (fora do repo) | Zero revisão; proibido ser importado pelo produto |

## Práticas

Cada uma ancorada no incidente que a motivou.

1. **Discriminador escrita-vs-exibição** — primeiro passo obrigatório em relato de "não salvou": conferir no banco se as escritas do usuário chegaram, antes de caçar o write path. No PR #425 e no diagnóstico de 2026-07 a escrita nunca tinha falhado — a tela é que apresentava o status errado.
2. **Prova do vermelho** — todo teste que acompanha bugfix é demonstrado falhando antes do fix; todo teste de regressão novo (unitário ou E2E) é sabotado uma vez para provar que morde (o `coding-save.smoke` foi validado contra a sabotagem "UI reporta sucesso sem escrever"). Trocar o canal de escrita (upsert→RPC etc.) exige re-provar vermelhos todos os guards afetados (#440).
3. **Mutação manual como juiz** — a afirmação "este guard está coberto" exige mutar o guard e ver o teste falhar (#454). Ferramenta dedicada: avaliação na #517.
4. **Teste por cópia de regra em cada fronteira** — regra duplicada entre TS client / Server Action / RPC SQL precisa de teste em cada cópia; ao caçar bug dessa família, grep pela regra, não pelo sintoma (#486/#493/#495).
5. **Replay de funções puras com dados de produção** — `npx tsx` (cwd em `frontend/` para o alias `@/`) sobre as funções reais com dados reais responde "o que a UI mostrava/decidia" por ordens de grandeza menos que E2E. Foi o discriminador decisivo do diagnóstico de 2026-07: a completude real de uma response se decide pelo replay de `isCodingComplete` (com `answer_field_hashes`), nunca por contagem crua de campos.
6. **Invariantes de banco executáveis** — `npm run invariants` (`frontend/scripts/invariants/check-invariants.ts`): asserções read-only de consistência contra o banco; verificam ESTADO, não código, então pegam drift que nenhum gate estático vê, qualquer que seja o código que o causou. Rodar após mudança em write path, após migration aplicada e ao investigar dado estranho. Duas regras: **invariantes nascem em pares** (a inversa de "concluído tem response" foi quem achou os casos reais); **FAIL vira issue no mesmo dia e nunca é silenciado no script** — mascarar invariante embute o drift como novo normal, mesma lógica que proíbe abaixar threshold de cobertura. Agendamento automático: #516.
7. **Hipóteses em paralelo** — bug com N teorias plausíveis: gerar N verificações descartáveis (uma por teoria, subagentes), cada uma devolvendo evidência; não escolher qual testar primeiro por intuição.

## Labels de revisão por PR

Todo PR recebe um label que declara o nível de revisão que ele exige, derivado do tier mais alto que o diff toca — a decisão de classificação fica visível e auditável, em vez de implícita:

| Label | Tier | O revisor deve |
|---|---|---|
| `revisão: integral` | 1 — write path, RLS/RPC, migrations, auth | Ler o diff inteiro, linha a linha; conferir a prova do vermelho do teste; rodar `npm run invariants` após merge+migration |
| `revisão: amostragem` | 2 — testes, specs, checker | Amostrar os testes e mutar os guards que protegem tier 1 (um guard mutado que não faça teste falhar reprova o PR) |
| `revisão: leve` | 3 — UI, docs, formatação | Revisar assinaturas, contratos e textos; confiar nos gates para o corpo |

Quem abre o PR aplica o label (agentes inclusive); o revisor confere se a classificação está certa antes de revisar — reclassificar para cima é sempre legítimo, para baixo exige justificativa no PR. Tier 4 não tem label: código descartável não vira PR.

## Regras operacionais

- Spec E2E novo: rodar a suíte inteira antes de declarar verde — mudança de ordem/timing pode expor hang pré-existente em spec vizinho (caso config-guard×coding-save no PR #522; o fix padrão para signOut travado em página de análise é `prepareSignOut` → `/dashboard`).
- Reparo de dado nunca é automático: achado do checker vira proposta com preflight embutido (o comando re-mede o estado antes de escrever), aprovada explicitamente antes do `--apply`.
- Scripts descartáveis e de reparo vivem fora do repositório (ver "Scripts one-off" no CLAUDE.md); no checkout do mantenedor há um diretório local `harness/` com o contrato completo da camada experimental.
