# Stack de qualidade de código

Decision record da issue [#260](https://github.com/bdcdo/dataframeitGUI/issues/260) ("Avaliar complementos ao react-doctor"). Registra quais ferramentas de qualidade o projeto adotou, por que cada uma entrou (ou ficou de fora), o baseline de cada gate e como o débito legado é grandfathered. Complementa `docs/LINT_CONFIG.md`, que detalha especificamente o baseline do react-doctor.

## O problema

O react-doctor entende a semântica de React *dentro do arquivo* — `useEffect` desnecessário, estado derivado, prop drilling, acessibilidade. Por design, ele abriu mão da detecção de código morto (delegada ao knip) e não enxerga três eixos: o grafo do projeto (o que nenhuma ferramenta arquivo-a-arquivo vê), os tipos (regras de lint que precisam do type-checker) e o runtime. Some-se a isso que o backend Python não tinha nenhum gate de qualidade e que a única automação de segurança era o gitleaks (secrets). A #260 fechou essas lacunas montando uma stack em que cada peça cobre um eixo distinto, com uma exigência transversal: nenhum gate pode depender de o desenvolvedor lembrar de rodar algo na mão.

## O mapa — quem dispara o quê

A regra de ouro é que tudo roda sozinho, via git hook ou automação de servidor. Os hooks se instalam de uma vez com `pre-commit install` (o `default_install_hook_types` em `.pre-commit-config.yaml` cobre os dois estágios). A divisão entre os estágios segue o custo: o que é leve e por-arquivo roda a cada commit; o que carrega o grafo do projeto ou o programa de tipos roda só no push.

| Quem dispara | Quando | Ferramentas | Grandfathering |
|---|---|---|---|
| `pre-commit` | todo commit (leve, file-scoped) | gitleaks · ruff (lint+format) · react-doctor | só o arquivo/linha tocado é checado |
| `pre-push` | todo `git push` (pesado, grafo/tipos) | typecheck · lint:types · fallow audit · semgrep · backend-pytest | new-only / file-scoped (ver cada um); pytest roda a suíte inteira |
| GitHub (servidor) | automático | Dependabot | n/a — abre PRs de vuln sozinho |
| on-demand | ao investigar performance | React Scan | n/a — ferramenta de diagnóstico, não gate |

A única peça manual é o React Scan, e por natureza: ele é um overlay visual que precisa da aplicação rodando no browser, então não há o que amarrar a um hook de git.

## As ferramentas adotadas

### fallow — o grafo do codebase

`fallow` 2.102.0 (devDependency pinada). É a peça que preenche a lacuna estrutural que o react-doctor deixou: constrói o grafo de módulos do projeto inteiro para achar o que ferramentas arquivo-a-arquivo não veem — export que ninguém importa, arquivo que ninguém importa, dependência circular, bloco duplicado entre arquivos, dependência no `package.json` nunca importada. É, na prática, um `knip` + `jscpd` em Rust, sub-segundo. A camada estática é MIT; a camada de runtime (paga) não foi adotada.

O gate usa `fallow audit` (script `npm run fallow:audit`, hook de pre-push). O `audit` é purpose-built para PR quality gates: roda dead-code + complexidade + duplicação escopados aos arquivos alterados e retorna um verdict (pass/warn/fail), com exit 1 em fail. O modo default `--gate new-only` faz o grandfathering por design — só achados *introduzidos* pelo changeset afetam o verdict; os herdados são reportados com atribuição new-vs-inherited mas não barram. O `audit` não recebe `--base`: sem ele, o fallow usa a merge-base com `origin/main`, o que evita o falso-positivo de comparar contra um `main` local defasado. O scan completo (`npm run fallow`, dead-code + dupes + health juntos) fica para inspeção manual.

Baseline (full scan, 3388 símbolos analisados, manutenibilidade global 90,7): **56 issues de dead-code** (ex.: `dropdown-menu.tsx` com 67% de exports mortos, `popover.tsx` 57%, `select.tsx` 50%), **121 grupos de clones** e **260 funções acima do threshold** de complexidade/manutenibilidade. Tudo isso é débito legado grandfathered pelo `--gate new-only`; nenhuma dessas linhas precisou ser tocada para o gate passar.

`frontend/.fallowrc.jsonc` (schema oficial do fallow) supressiona dois falsos-positivos: `scripts/comentarios-relatorio/**` (`ignorePatterns` — script chamado manualmente via `tsx`, nunca por um entry point do Next) e cada arquivo de primitiva shadcn/Radix em `src/components/ui/` (`ignoreExports`, enumerados um a um — mesmo raciocínio do #230 no react-doctor, ver `docs/LINT_CONFIG.md`). A enumeração é deliberada em vez de um glob `src/components/ui/**`: o diretório também guarda componentes próprios do projeto (`confirm-action-dialog.tsx`, `CopyLinkButton.tsx`) que devem continuar sob checagem normal de dead-code — um glob amplo os esconderia do gate junto com as primitivas geradas.

### typescript-eslint type-checked — os tipos

`typescript-eslint` 8.62.0 (devDependency pinada), via a config dedicada `frontend/eslint.config.typed.mjs` e o script `npm run lint:types`. É separada da config base (`eslint.config.mjs`) e do `npm run lint` rápido porque regras type-checked precisam do `projectService` (carregam o programa de tipos inteiro) e são lentas demais para o lint do dia a dia. O subset é curado de propósito — `no-floating-promises` e `no-misused-promises`, não o `recommendedTypeChecked` inteiro — para mirar o footgun que mais aparece nesta base: promessa async não-tratada em Server Action, hook ou handler de evento.

A escolha se justifica empiricamente: o primeiro scan encontrou **59 errors** em cerca de 11 arquivos — promessas não-aguardadas em `useDocumentText`, `useLlmRunProgress`, `useFieldOrder`, `usePromptPreview`, em componentes como `UserMenu`, `RunLlmButton`, `CopyLinkButton`, `ExportPanel`, e em Server Actions. São bugs latentes que o lint sintático não via. O gate de pre-push roda file-scoped (passa só os `.ts/.tsx` alterados, com o prefixo `frontend/` removido), então os 59 ficam grandfathered — o hook só barra promessa não-tratada num arquivo que você efetivamente tocar.

### typecheck (tsc) — o prerequisito que faltava

O projeto não tinha sequer um script `tsc --noEmit`. O `npm run typecheck` preenche isso e roda no pre-push (projeto inteiro, sem grandfathering — hoje passa com **0 erros**, então qualquer erro de tipo novo barra o push). O compilador nativo em Go (tsgo / TypeScript 7) está em RC mas ainda não foi adotado (ver "Monitorar"); quando o GA sair, basta trocar `tsc` por `tsgo` nesse script.

### ruff — lint, format e complexidade do backend

`ruff` (dependency-group dev em `backend/pyproject.toml`), via o hook oficial `astral-sh/ruff-pre-commit` v0.15.19. Cobre o backend Python, que não tinha nenhum gate. Resolve o eixo de complexidade que a #260 levantou (a pergunta original era sobre o `lizard`): no frontend a complexidade já está coberta por react-doctor + fallow, então a lacuna real era o Python, e o `ruff` entrega `C901` (mccabe) junto com lint (E/F/I/B) e format num binário só — mais que o `lizard`, que só mede CCN.

Config em `backend/pyproject.toml`: `select = ["E", "F", "I", "B", "C901"]`, `ignore = ["E501"]` (comprimento de linha fica a cargo do `ruff format`), `max-complexity = 10`. Os hooks rodam file-scoped (só os `.py` alterados), com `--fix` no lint, então o débito legado fica grandfathered por arquivo-tocado. As três funções legadas acima do limite de complexidade — `evaluate_condition` (13), `compile_pydantic` (20) e `run_llm` (35) — são grandfathered explicitamente via `per-file-ignores`, porque refatorá-las está fora do escopo de um PR de tooling; novas funções complexas nos demais arquivos continuam disparando `C901`. Baseline restante: 8 achados auto-fixáveis (7 imports desordenados, 1 import morto) e 16 de 22 arquivos que o `ruff format` reformataria ao serem tocados.

### backend-pytest — a suíte do backend como gate

Enquanto o `ruff` cobre o eixo estático do Python, ele não roda os testes — a suíte de auth que o #195 adicionou (`backend/tests/`) não gateava nada, então uma regressão que enfraquecesse o gate JWT ou quebrasse as fronteiras 401/403/404/503 mergearia com o gate verde e o deploy do Fly shipparia direto para produção (issue #337). O hook local `backend-pytest` fecha essa lacuna: roda `uv run pytest -q` (working-dir `backend/`) no estágio de pre-push sempre que o push toca `backend/**/*.py`. Diferente dos hooks file-scoped, roda a suíte inteira — testes não têm noção de "linha grandfathered". Diferente do semgrep (fail-open em erro de infra), é **fail-closed**: se o `uv` não estiver no PATH o push é barrado com mensagem, porque é um gate de verdade, não um sinal informativo. `[tool.uv] package = false` no `backend/pyproject.toml` faz o `uv run` não tentar empacotar o app (que é um FastAPI flat, não uma lib instalável), evitando a regressão histórica de build. Coerente com a decisão de manter o gate pré-merge nos hooks locais e não em GitHub Actions (sem branch protection no free tier, um job de Actions não bloqueia merge).

### React Scan — o runtime

`react-scan` 0.5.7 (devDependency pinada), via `npm run scan` contra a aplicação em dev. É o eixo que o react-doctor estático não alcança: detecta re-renders desnecessários ao vivo. Casa com a dívida de performance registrada na constituição ("diagnosticar e corrigir a lentidão atual da plataforma"). É ferramenta de diagnóstico pontual, não gate — roda quando se investiga performance, não em CI.

### Dependabot e semgrep — a segurança

Sobre o gitleaks (secrets) que já existia, a #260 acrescentou duas camadas. O **Dependabot** (`.github/dependabot.yml`) cobre dependências vulneráveis nos três ecossistemas (npm em `/frontend`, pip em `/backend`, github-actions): roda no servidor do GitHub e abre PRs sozinho, com `cooldown` de 7 dias antes de propor uma versão recém-publicada — janela de defesa contra supply-chain. O **semgrep** (hook de pre-push via `uvx`, rulesets `p/typescript`, `p/react`, `p/python`) faz SAST de código inseguro em JS/TS e Python, complementando as poucas regras de Security do react-doctor. O `--baseline-commit` limita aos achados novos vs `origin/main` (grandfathering); o hook falha fechado em achado real (exit 1) e falha aberto em erro de infra/rede (exit > 1), para não travar um push offline.

## Setup (uma vez por checkout)

```bash
cd frontend && npm install            # instala fallow, typescript-eslint, react-scan
uv tool install pre-commit            # se ainda nao tiver
pre-commit install                    # instala os hooks de pre-commit E pre-push
```

A partir daí os gates rodam sozinhos. Comandos manuais (para debug ou inspeção) ficam documentados, mas não são necessários no dia a dia:

```bash
cd frontend
npm run typecheck        # tsc --noEmit
npm run lint:types       # typescript-eslint type-checked (projeto inteiro)
npm run fallow           # scan completo (dead-code + dupes + health)
npm run fallow:audit     # gate incremental (new-only vs origin/main)
npm run scan             # React Scan (precisa de `npm run dev` rodando)

cd backend
uv run ruff check .      # lint (ruff do dev-group via uv.lock; o hook pina v0.15.19)
uv run ruff format .     # format
```

## Monitorar

- **tsgo / TypeScript 7 (Project Corsa)** — compilador nativo em Go, ~10× mais rápido, em RC desde 18/06/2026, GA estimado ~1 mês depois. Não adotado agora: a API programática só entra na 7.1, então `typescript-eslint`/`ts-morph` ainda não rodam sobre o nativo. Quando o GA sair, trocar `tsc` por `tsgo` no script `typecheck` é um drop-in. O agente também pode chamar o MCP/skill do fallow e os findings do semgrep guardian sob demanda.

## Avaliadas e diferidas

- **lizard** (complexidade ciclomática portável) — redundante no frontend (react-doctor + fallow já cobrem) e mais raso que o `ruff` no backend (só mede CCN, não faz lint). Coberto pelo `ruff`.
- **mypy** (type-check Python) — não pedido nesta rodada; complementaria o `ruff` no backend.
- **Biome** (lint+format all-in-one) — sobreporia o investimento já feito em ESLint + react-doctor.
- **type-coverage** — o projeto já é `strict`; ganho marginal fora de migração/caça a `any`.
- **Analisadores de bundle** (vite-bundle-visualizer, source-map-explorer) — só se performance de bundle pesar; a dívida de performance atual não é de bundle.
- **CI bloqueante no GitHub Actions** (Vitest + pytest + lint + typecheck) — é o TODO da constituição (Princípio V), de escopo maior, fora desta rodada. Quando existir, os hooks mais pesados (semgrep, fallow full) podem migrar do pre-push para o CI.
