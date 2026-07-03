# Stack de qualidade de código

Decision record da issue [#260](https://github.com/bdcdo/dataframeitGUI/issues/260) ("Avaliar complementos ao react-doctor"). Registra quais ferramentas de qualidade o projeto adotou, por que cada uma entrou (ou ficou de fora), o baseline de cada gate e como o débito legado é grandfathered. Complementa `docs/LINT_CONFIG.md`, que detalha especificamente o baseline do react-doctor.

## O problema

O react-doctor entende a semântica de React *dentro do arquivo* — `useEffect` desnecessário, estado derivado, prop drilling, acessibilidade. Por design, ele abriu mão da detecção de código morto (delegada ao knip) e não enxerga três eixos: o grafo do projeto (o que nenhuma ferramenta arquivo-a-arquivo vê), os tipos (regras de lint que precisam do type-checker) e o runtime. Some-se a isso que o backend Python não tinha nenhum gate de qualidade e que a única automação de segurança era o gitleaks (secrets). A #260 fechou essas lacunas montando uma stack em que cada peça cobre um eixo distinto, com uma exigência transversal: nenhum gate pode depender de o desenvolvedor lembrar de rodar algo na mão.

## O mapa — quem dispara o quê

A regra de ouro é que tudo roda sozinho, via git hook ou automação de servidor. Os hooks se instalam de uma vez com `pre-commit install` (o `default_install_hook_types` em `.pre-commit-config.yaml` cobre os dois estágios). A divisão entre os estágios segue o custo: o que é leve e por-arquivo roda a cada commit; o que carrega o grafo do projeto ou o programa de tipos roda só no push.

| Quem dispara | Quando | Ferramentas | Grandfathering |
|---|---|---|---|
| `pre-commit` | todo commit (leve, file-scoped) | gitleaks · ruff (lint+format) · react-doctor | só o arquivo/linha tocado é checado |
| `pre-push` | todo `git push` (pesado, grafo/tipos) | typecheck · lint:types · fallow audit · semgrep · backend-pytest · mypy | new-only / file-scoped (ver cada um); pytest roda a suíte inteira |
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

A escolha se justificou empiricamente: o primeiro scan encontrou 59 errors em cerca de 11 arquivos — promessas não-aguardadas em hooks como `useLlmRunProgress`, `useFieldOrder`, `usePromptPreview`, em componentes como `UserMenu`, `RunLlmButton`, `CopyLinkButton`, `ExportPanel`, e em Server Actions. Eram bugs latentes que o lint sintático não via (ex.: falha de rede silenciosa ao salvar, sem toast nem log). A issue [#378](https://github.com/bdcdo/dataframeitGUI/issues/378) (onda `lint:types` da epic [#376](https://github.com/bdcdo/dataframeitGUI/issues/376)) zerou o débito real (46 errors, 25 arquivos no scan atual): hoje `npm run lint:types` passa com **0 errors** de `no-floating-promises`/`no-misused-promises` no projeto inteiro — o gate de pre-push segue file-scoped por velocidade, mas não há mais débito legado escondido atrás dele.

### typecheck (tsc) — o prerequisito que faltava

O projeto não tinha sequer um script `tsc --noEmit`. O `npm run typecheck` preenche isso e roda no pre-push (projeto inteiro, sem grandfathering — hoje passa com **0 erros**, então qualquer erro de tipo novo barra o push). O compilador nativo em Go (tsgo / TypeScript 7) está em RC mas ainda não foi adotado (ver "Monitorar"); quando o GA sair, basta trocar `tsc` por `tsgo` nesse script.

### ruff — lint, format e complexidade do backend

`ruff` (dependency-group dev em `backend/pyproject.toml`), via o hook oficial `astral-sh/ruff-pre-commit` v0.15.19. Cobre o backend Python, que não tinha nenhum gate. Resolve o eixo de complexidade que a #260 levantou (a pergunta original era sobre o `lizard`): no frontend a complexidade já está coberta por react-doctor + fallow, então a lacuna real era o Python, e o `ruff` entrega `C901` (mccabe) junto com lint (E/F/I/B) e format num binário só — mais que o `lizard`, que só mede CCN.

Config em `backend/pyproject.toml`: `select = ["E", "F", "I", "B", "C901"]`, `ignore = ["E501"]` (comprimento de linha fica a cargo do `ruff format`), `max-complexity = 10`. Os hooks rodam file-scoped (só os `.py` alterados), com `--fix` no lint, então o débito legado fica grandfathered por arquivo-tocado.

**Atualização (#376, 2026-07):** dos 8 achados auto-fixáveis e 16 arquivos pendentes de format do baseline original, só restavam 10 arquivos pendentes de format no momento da #376 (o lint já estava zerado por trabalho anterior não documentado) — resolvidos com `ruff format .`. Das três funções originalmente isentas de `C901` via `per-file-ignores`, duas foram refatoradas e removidas da isenção:

- **`evaluate_condition`** (era 13): extraída em dispatch dict por operador (`equals`/`not_equals`/`in`/`not_in`/`exists`), cada ramo virou uma função auxiliar de baixa complexidade.
- **`compile_pydantic`** (era 20): o loop de normalização de metadata pós-modelo (help_text, subfield_rule, allow_other, condition, justification_prompt, sufixos de description) foi extraído em funções auxiliares (`extract_json_schema_extra`, `_resolve_field_type_and_options`, `_strip_description_suffixes`, `_assemble_field_dict`, `_build_field_dict`). A allowlist de segurança AST (`build_model_from_code`/`_reject_dangerous`/`_resolve_type`) não foi tocada.

Ao remover a isenção de arquivo inteiro de `pydantic_compiler.py`, o gate revelou que **duas funções da própria allowlist de segurança também excediam o limite** — `_reject_dangerous` (14) e `_resolve_type` (12) — escondidas até então pelo `per-file-ignores` de arquivo inteiro. São isentas agora via `# noqa: C901` inline (não mais `per-file-ignores`), pela mesma cautela nas duas mas por motivos técnicos distintos (documentados no docstring de cada uma): `_reject_dangerous` é um único `ast.walk` cujos `if`s são checagens de allowlist independentes — decompor não fragmentaria o walk, mas é código de segurança e um refactor apressado arrisca introduzir uma brecha sem reduzir risco real; `_resolve_type` é dispatch recursivo (sem um `ast.walk` central), e alguns ramos poderiam em tese virar funções auxiliares, mas a mesma cautela de segurança se aplica. A suppression pontual por linha, em vez de isenção de arquivo inteiro, é a melhoria real aqui — qualquer *nova* função complexa em `pydantic_compiler.py` volta a disparar `C901` normalmente.

**Correção de uma revisão do PR #379 (2026-07-03):** a extração de `evaluate_condition`/`compile_pydantic` introduziu duas duplicações, corrigidas no mesmo PR. Primeiro, o guard de normalização de `json_schema_extra` (callable/isinstance-dict/default-`{}`) existia de forma independente em três lugares (`condition_evaluator.py`, `pydantic_compiler.py`, `llm_runner.py`); consolidado no único helper público `pydantic_compiler.extract_json_schema_extra`. Segundo, a lista de operadores de condição (`equals`/`not_equals`/`in`/`not_in`/`exists`) tinha duas cópias independentes (`_CONDITION_OPS` em `pydantic_compiler.py` e o novo `_CONDITION_HANDLERS` em `condition_evaluator.py`); a primeira virou a constante pública `CONDITION_OPERATORS`, e o dispatch de `condition_evaluator.py` deriva sua ordem dela.

**`run_llm`** (35, `services/llm_runner.py`) permanece isenta via `per-file-ignores` — é a mais complexa das três e, diferente das outras duas, está sob desenvolvimento ativo (edições em 4 meses consecutivos) e não tem nenhum teste de integração direto (só os helpers já extraídos são testados). Refatorar sem essa rede de segurança seria extrair "às cegas". Pré-requisito e plano incremental documentados na sub-issue [#377](https://github.com/bdcdo/dataframeitGUI/issues/377).

### backend-pytest — a suíte do backend como gate

Enquanto o `ruff` cobre o eixo estático do Python, ele não roda os testes — a suíte de auth que o #195 adicionou (`backend/tests/`) não gateava nada, então uma regressão que enfraquecesse o gate JWT ou quebrasse as fronteiras 401/403/404/503 mergearia com o gate verde e o deploy do Fly shipparia direto para produção (issue #337). O hook local `backend-pytest` fecha essa lacuna: roda `uv run pytest -q` (working-dir `backend/`) no estágio de pre-push sempre que o push toca `backend/**/*.py`. Diferente dos hooks file-scoped, roda a suíte inteira — testes não têm noção de "linha grandfathered". Diferente do semgrep (fail-open em erro de infra), é **fail-closed**: se o `uv` não estiver no PATH o push é barrado com mensagem, porque é um gate de verdade, não um sinal informativo. `[tool.uv] package = false` no `backend/pyproject.toml` faz o `uv run` não tentar empacotar o app (que é um FastAPI flat, não uma lib instalável), evitando a regressão histórica de build. Coerente com a decisão de manter o gate pré-merge nos hooks locais e não em GitHub Actions (sem branch protection no free tier, um job de Actions não bloqueia merge).

### mypy — o eixo de tipos do backend

`mypy` (dependency-group dev em `backend/pyproject.toml`, `>=1.15`), via hook local de pre-push, escopado aos `.py` alterados (mesmo padrão do `lint-types` do frontend). Fecha a lacuna que o `ruff` deixa: `ruff` cobre lint/format/complexidade, mas não checa tipos — o backend é o boundary de segurança internet-facing (pós-#195/#337) e um `Any` vazando de um `dict` cru do LLM até um argumento tipado é exatamente o footgun que motivou o `no-floating-promises` no frontend, só que do lado dos tipos.

Config em `backend/pyproject.toml`: `ignore_missing_imports = true` (as libs de LLM — `langchain-*`, `dataframeit` — não publicam stubs; sem isso todo `import-untyped` mascararia os erros reais) e sem `strict` de cara, mesmo raciocínio do subset curado do `lint:types` no frontend. `python_version = "3.12"` casa com o runtime real (Dockerfile e `.venv`), não com o piso `requires-python = ">=3.11"` — simular 3.11 faz o mypy recusar parsear sintaxe 3.12+ em stubs de terceiros (ex.: `type` statement do PEP 695 no stub do `numpy`) e abortar em vez de reportar um erro de tipo normal.

`follow_imports = "silent"` é o que faz o grandfathering file-scoped funcionar de fato: sem ele, checar um único arquivo (como o hook de pre-push faz) também reporta erros de qualquer módulo que esse arquivo importe — como `services/auth.py` é importado por praticamente toda rota, qualquer push que tocasse `routes/llm_routes.py` (por exemplo) bloquearia pelos erros legados de `auth.py`, mesmo sem editá-lo. Com `silent`, o módulo importado continua sendo checado (a inferência de tipo permanece correta) mas seus diagnósticos ficam suprimidos quando ele não é o alvo explícito do comando.

`exclude = ["tests/"]` só tem efeito no modo de descoberta de projeto (`uv run mypy .`); é ignorado quando arquivos são passados explicitamente, que é como o hook invoca o mypy. A proteção real de `tests/` no hook vem do `exclude: ^backend/tests/.*\.py$` em `.pre-commit-config.yaml` — os dois precisam ficar em sincronia manualmente, não há enforcement cruzado entre eles.

O primeiro scan completo encontrou **113 erros em 5 arquivos**, com **103 (91%) concentrados em `services/llm_runner.py`** — quase todos `union-attr`/`arg-type` da explosão do alias `JSON` recursivo (`int | float | Sequence[JSON] | Mapping[str, JSON] | None`) toda vez que um `dict` cru vindo do LLM é acessado. É o mesmo arquivo já isento de `C901` no `ruff` (`run_llm`, CCN 35) — tipar direito exige o mesmo refactor maior, fora do escopo de um PR de tooling. Por isso `services/llm_runner.py` é isento por inteiro via `[[tool.mypy.overrides]]` (`ignore_errors = true`), do mesmo jeito que o `per-file-ignores` do `ruff` isenta sua complexidade — sem isso, qualquer push que tocasse o arquivo bloquearia nos 103 erros pré-existentes, já que o hook é file-scoped (não line-scoped). Os 10 erros restantes em 4 arquivos (`services/auth.py`: 4, `routes/pydantic_routes.py`: 4, `services/pydantic_compiler.py`: 1, `main.py`: 1), inicialmente grandfathered pelo escopo file-a-file do hook, foram corrigidos na issue [#380](https://github.com/bdcdo/dataframeitGUI/issues/380) — `uv run mypy .` roda limpo hoje, com exceção de `services/llm_runner.py`.

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
uv run mypy .            # type-check (llm_runner.py isento; ver seção mypy acima)
```

## Monitorar

- **tsgo / TypeScript 7 (Project Corsa)** — compilador nativo em Go, ~10× mais rápido, em RC desde 18/06/2026, GA estimado ~1 mês depois. Não adotado agora: a API programática só entra na 7.1, então `typescript-eslint`/`ts-morph` ainda não rodam sobre o nativo. Quando o GA sair, trocar `tsc` por `tsgo` no script `typecheck` é um drop-in. O agente também pode chamar o MCP/skill do fallow e os findings do semgrep guardian sob demanda.

## Avaliadas e diferidas

- **lizard** (complexidade ciclomática portável) — redundante no frontend (react-doctor + fallow já cobrem) e mais raso que o `ruff` no backend (só mede CCN, não faz lint). Coberto pelo `ruff`.
- **Biome** (lint+format all-in-one) — sobreporia o investimento já feito em ESLint + react-doctor.
- **type-coverage** — o projeto já é `strict`; ganho marginal fora de migração/caça a `any`.
- **Analisadores de bundle** (vite-bundle-visualizer, source-map-explorer) — só se performance de bundle pesar; a dívida de performance atual não é de bundle.
- **CI bloqueante no GitHub Actions** (Vitest + pytest + lint + typecheck) — é o TODO da constituição (Princípio V), de escopo maior, fora desta rodada. Quando existir, os hooks mais pesados (semgrep, fallow full) podem migrar do pre-push para o CI.
