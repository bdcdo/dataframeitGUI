# dataframeitGUI

Plataforma web para analise de conteudo de documentos. Coordenadores definem perguntas (Pydantic), atribuem documentos a pesquisadores, rodam LLM. Pesquisadores codificam e revisam. Comparacoes automaticas quando ha N+ respostas para o mesmo documento.

## Arquitetura

```
Browser  →  Next.js 16 (Fly.io)  ←→  Supabase (Postgres + RLS)
                |                            ^
                | Clerk (Auth + JWT)         |
                | HTTP (LLM + Pydantic)      |
                v                            |
            FastAPI (Fly.io)  ───────────────┘
              |-- dataframeit           (service key)
              |-- Pydantic compiler
```

## Convencoes

- **Portugues** para UI (labels, mensagens), **ingles** para codigo (vars, funcs, types)
- **Brand color**: teal #2F6868 = `oklch(0.44 0.08 185)`
- **Alvo e desktop/mouse, nao toque**: otimizar densidade e alvos de clique para mouse — nao aplicar o minimo de 44px de toque. Em caso de tradeoff, priorizar densidade de informacao.
- **shadcn/ui** para todos os componentes de UI
- **Decisoes de UI e seus porques** (codificacao em lista e deliberada, codigo Pydantic somente-leitura, veredito em dois passos): **`docs/UI.md`**. Antes de propor mudanca de interface que pareca "corrigir uma regressao", conferir la se a forma atual nao e escolha registrada. O arquivo so guarda intencao — descricao de tela e medida em pixel vivem no codigo, deliberadamente (ver #611).
- **Server Actions** para mutations, **RSC** para reads
- Auth: Clerk (`lib/auth.ts` para `getAuthUser()`, `lib/clerk-sync.ts` para sync Clerk↔Supabase)
- Supabase client: `lib/supabase/server.ts` (server, autenticado via Clerk JWT) e `lib/supabase/admin.ts` (service key)
- **FastAPI** so para LLM e Pydantic (nao para CRUD)
- **EditFieldDialog**: toda config de schema acessivel na aba Schema deve ser igualmente acessivel via `EditFieldDialog` inline (Comentarios e LLM Insights). Ao adicionar um campo novo a `PydanticField`, garantir que ambos os editores (FieldCard e EditFieldDialog) o exponham.
- **Pydantic = fonte de verdade do schema**: toda propriedade de `PydanticField` (inferida do schema Zod em `frontend/src/lib/pydantic-field.ts`) deve ser transportada no codigo Pydantic gerado — via annotation, `Field(...)` ou `json_schema_extra={...}`. E proibido depender apenas do JSON em `projects.pydantic_fields` para reconstruir um campo. Motivo: garantir que `projects.pydantic_code` seja fonte de verdade reconstruivel — o `llm_runner` recria o modelo a partir dele (via `build_model_from_code`) para rodar o LLM, e o round-trip `UI -> pydantic_code -> compile_pydantic -> UI` precisa ser completo sem depender do JSON. (O codigo e read-only na UI e gerado pela GUI desde o PR #197; a completude segue exigida pela reconstrucao no backend e pelo round-trip.) Ao adicionar um campo novo a `PydanticField`, atualize:
  - (a) `generatePydanticCode()` em `frontend/src/lib/schema-utils.ts` para emitir a propriedade. Em `json_schema_extra`, nao usar as chaves que a biblioteca dataframeit le com sentido proprio (a fonte e `_LIBRARY_EXTRA_KEYS` em `dataframeit/agent.py`; hoje `condition`, `depends_on`, `prompt`, `prompt_replace`, `prompt_append`, `search_depth`, `max_results`, `max_search_calls`): a visibilidade do campo sai como `visible_if` por isso (`VISIBILITY_KEY` em `backend/services/pydantic_compiler.py`);
  - (b) `compile_pydantic()` em `backend/services/pydantic_compiler.py` para le-la de volta;
  - (c) as primitivas de versionamento/auditoria em `frontend/src/lib/schema-utils.ts` — `snapshotOf`, `diffFields`, `fieldDiffIsStructural` — para que a mudanca da propriedade seja classificada (minor/patch) e registrada em `schema_change_log`. Essas primitivas sao puras e compartilhadas entre `saveSchemaFromGUI` e scripts fora do Next runtime, justamente para evitar drift (ver #63). **Nao edite `classifyChange`**: ele e derivado de `diffFields` + `fieldDiffIsStructural`, e e essa derivacao que sustenta a invariante `classifyChange != null ⇒ diffFields != []` de que o save depende (a RPC recusa log vazio);
  - (c2) se a propriedade tiver **default implicito** (ausente significa um valor, e nao "sem valor"), declare o default uma unica vez como resolvedor em `frontend/src/lib/pydantic-field.ts` — junto dos que ja existem, cuja lista canonica e o proprio arquivo — e use o resolvedor em todo consumidor; nunca re-derive o default com `?? x` / `!== y` / `Boolean(...)` no call site. Motivo: `snapshotOf` e a serializacao canonica que define "campo igual" para a deteccao de dirty, para `sameFieldContent` e — propriedade a propriedade — para `mergeFieldProperties`, enquanto `diffFields` decide o versionamento e o diff de historico le o payload gravado; quando esses pontos normalizavam diferente, um campo sem `target` divergia de um com `target: "all"` e o merge acusava "editado remotamente" sem edicao, `Boolean(null)` fazia o historico nao renderizar a mudanca de obrigatoriedade, e um campo legado sem `subfield_rule` virava MINOR quando o `EditFieldDialog` promovia o default a explicito. Nao use `.default()` no Zod: o codigo depende de `undefined` ser distinguivel (a UI grava `required: undefined` para "obrigatorio").
    **Nao crie uma segunda tabela propriedade→resolvedor.** `mergeFieldProperties` (`schema-merge.ts`) compara indexando `snapshotOf`, e nao os campos crus, justamente para que a normalizacao seja unica por construcao em vez de por acordo mantido a mao — o teste em `schema-draft.test.ts` fixa a equivalencia de chaves de que isso depende. Uma tabela paralela ali ja fabricou conflito de merge tres vezes (`hash`, `target`, `subfield_rule`), uma por rodada de revisao;
  - (d) o diff de historico em `frontend/src/lib/schema-change-diff.ts` (`FieldPropertyDiff`, `diffPydanticField`) e `frontend/src/lib/schema-change-format.ts` (`PROPERTY_LABELS`), consumidos pelo renderizador `FieldChangeDiff.tsx`.
  - (e) o schema Zod fail-closed em `frontend/src/lib/pydantic-field.ts`, que define `PydanticField`, valida os dados persistidos e recupera rascunhos locais sem aceitar propriedades desconhecidas. A propriedade nova deve ser declarada uma unica vez nesse schema e ganhar teste de round-trip do draft.

  **Cuidado com o `pydantic_hash`**: `projects.pydantic_hash` e sha256 do **texto** do codigo gerado, entao emitir uma chave nova em `json_schema_extra` muda o hash de todo projeto afetado no proximo save — e respostas LLM legadas (sem `answer_field_hashes` e sem semver gravado) tem esse hash como unico vinculo com o schema, logo saem da fila de Comparacao (ver `20260505000001_revive_orphan_llm_responses.sql`). Por isso o padrao e **emitir apenas o caso nao-default**: assim o texto fica byte-identico para quem nao usa a propriedade. `computeFieldHash` (`name|type|options|description`, mais `|r<n>` so quando o campo tem `question_revision`) nao e afetado.

  **Direcao registrada**: por seguranca, a representacao canonica do schema deve migrar de codigo Pydantic (Python compilado no backend a partir de texto editavel por usuario) para JSON declarativo. Ate essa migracao acontecer, todas as regras (a)–(e) acima valem integralmente; qualquer migracao deve preservar o round-trip completo e o versionamento em `schema_change_log`.
- Testes: **Vitest** (frontend), **pytest** (backend)

## Regras de produto

- **Segurança**: a service key do Supabase nunca chega ao cliente, que opera só com o JWT do Clerk mais RLS. `lib/supabase/admin.ts` é `server-only`, e todo módulo que o importa está no inventário de `supabase-admin-boundary.test.ts`. Segredos só em variável de ambiente. Vazamento de dado entre projetos é incidente de severidade máxima. Enquanto o schema for código Pydantic, `compile_pydantic` é superfície de ataque e se endurece a cada mudança.
- **RLS por padrão**: toda tabela nova nasce, na mesma migration, com RLS habilitado, policies por papel (coordenador, pesquisador e flags como `can_arbitrate` quando couberem) e índice nas colunas que as policies usam (tipicamente `user_id` e `project_id`). Acesso pela service key é pontual, justificado no código e restrito ao que a RLS não cobre.
- **Testes**: código novo em `frontend/src/lib`, `frontend/src/actions`, `backend/services` e `backend/routes` vem com teste, e correção de bug vem com teste de regressão que falhava antes dela.
- **Acessibilidade WCAG 2.1 AA**: navegação completa por teclado, contraste AA, `aria-*` correto, foco visível e label associado a todo campo de formulário. O shadcn/ui traz a base, e customização a preserva. AA não exige alvo de toque, mas o alvo desktop não autoriza quebrar a tela em janela estreita ou com zoom.

## Supabase CLI

Projeto remoto: `nryebmwlmxuwvynfuzsv` (extraido de `NEXT_PUBLIC_SUPABASE_URL` em `frontend/.env.local`).

Antes de rodar qualquer comando `supabase` (db push, migration list, etc.):

```bash
cd frontend
# Exportar token (obrigatorio para CLI)
export SUPABASE_ACCESS_TOKEN=$(grep SUPABASE_ACCESS_TOKEN .env.local | cut -d= -f2)
# Linkar se necessario (idempotente, nao falha se ja linkado)
npx supabase link --project-ref nryebmwlmxuwvynfuzsv
```

Para aplicar migrations pendentes: `npx supabase db push`

## Deploy

Deploy e automatico a partir de merge no branch `main`. Frontend: Fly.io (app `gui-analise-sistematica-frontend`), servindo `dataframeit.com.br`. Backend: Fly.io (app `gui-analise-sistematica-api`) via workflow quando ha mudanca em `backend/**`. **Preferir branch + PR** ao push direto na main. Fluxo recomendado:

1. **Criar git worktree isolado** para a tarefa (ver secao "Workspace isolado" abaixo) — nao trabalhar no diretorio principal
2. Criar branch descritiva (`feat/...`, `fix/...`, `perf/...`) na worktree
3. Commitar nela
4. Ao final, abrir PR contra `main` via `gh pr create`
5. Com o plano aprovado, mesclar depois da revisao sem achado aberto e do CI verde
6. Remover a worktree apos o merge

## Workspace isolado (worktree)

**Sempre trabalhar em git worktree separado**, nunca no diretorio principal: o usuario pode estar trabalhando em outra branch ali, e um `git checkout` de qualquer dos lados deixa os edits do outro no historico da branch errada. Criar no inicio da tarefa com `git worktree add ../worktrees/<descricao-curta> -b <branch-name>`, fazer la todos os edits, commits, push e `gh pr create`, e, apos o merge, remover da raiz do repositorio com `git worktree remove ../worktrees/<descricao-curta>`. Excecao: tarefas read-only puras (responder duvida, ler codigo) podem ser feitas no diretorio principal.

## Como rodar

```bash
# Backend (nao esta em script de manifest)
cd backend && uv run uvicorn main:app --reload
```

Demais comandos: scripts em `frontend/package.json` (`dev`, `lint`, `typecheck`, `lint:types`, `react-doctor`, `fallow`, `scan`, `test:e2e`, `invariants`, `test:db:*`). Duas ressalvas que o script nao conta: o `scan` precisa de `npm run dev` rodando, e o `test:e2e` roda permissivo na mao mas como gate fail-closed no pre-push.

A stack de qualidade cobre quatro eixos — react-doctor (React no arquivo), **fallow** (grafo do codebase), **typescript-eslint type-checked** (tipos), **React Scan** (runtime) — mais **ruff** no backend Python, **actionlint** e o teste comportamental dos workflows de deploy, **Vitest/Playwright/pytest** (testes) e **Dependabot + semgrep** (segurança, sobre o gitleaks já existente). O princípio é que **nada depende de lembrar de rodar**: os hooks de `.pre-commit-config.yaml` disparam sozinhos, divididos em dois estágios — pre-commit (leve/file-scoped: gitleaks, ruff, actionlint, deploy notifier, react-doctor) e pre-push (pesado/grafo: typecheck, vitest, e2e-smoke, lint:types, fallow audit, semgrep, backend-pytest, mypy). Setup (1x): `cd frontend && npm install && uv tool install pre-commit && pre-commit install` (instala os dois estágios). Cada gate grandfathers o débito legado quando aplicável (new-only no fallow/semgrep, file-scoped no ruff/lint:types/mypy, line-scoped no react-doctor); vitest, e2e-smoke e backend-pytest rodam como gates de teste. Decisão completa, baselines e o que foi diferido (tsgo, Biome) em **`docs/CODE_QUALITY_TOOLING.md`**; baseline e regras silenciadas do react-doctor em `docs/LINT_CONFIG.md`.

**Estratégia de verificação** (práticas anti-"codificação não salva": discriminador escrita-vs-exibição, prova do vermelho, replay com dados de produção, invariantes de banco via `npm run invariants`): **`docs/VERIFICATION.md`**.

O **react-doctor** roda como hook **local de pre-commit**, line-scoped, via `frontend/scripts/react-doctor-gate.sh` nos commits que tocam `frontend/**/*.{ts,tsx}`: **bloqueia se a linha alterada produzir qualquer diagnóstico** — error ou warning. O débito legado fica grandfathered. Por ser local e opt-in, é rede de proteção do dev, não portão de merge no servidor. Versão pinada, config (fonte única) e regras silenciadas: `frontend/package.json`, `frontend/doctor.config.json` e `docs/LINT_CONFIG.md`.

## Scripts one-off de dados / específicos de projeto

Scripts pontuais que operam sobre os dados de **um projeto específico** (dedup, correção de import, migração de dados ad hoc, re-OCR) **não vão para o repositório geral**: vivem em `pipeline-processos/` (gitignored), junto dos outros utilitários locais do Zolgensma. Motivo: carregam IDs e suposições de um projeto/dataset, não são reutilizáveis nem revisáveis como código de produto, e versioná-los polui o repo e expõe dados do banco (backups). Quando precisar resolver o `.env.local`, use caminho canônico do `frontend/` ou a env var `SUPABASE_ENV_PATH` — nunca suba a árvore de diretórios.

Vai para o repo (PR normal) só a **correção de causa raiz genérica** que decorre desse trabalho — migration, mudança de comportamento no app, teste.

## Performance — Regras de Arquitetura

Navegação e ações devem parecer instantâneas, e lentidão reportada entra como bug. Metas: transição de rota com p75 < 2 s, feedback visual de mutation < 200 ms e LCP < 2,5 s na lista de projetos, na codificação e na comparação.

### Queries Supabase
- **Nunca usar `.select("*")`** — sempre listar colunas explicitas (ex: `.select("id, title, created_at")`)
- **Nunca buscar todos os registros sem `.limit()`** em paginas que podem ter muitos dados
- **Usar `count()` do Supabase** ao inves de buscar registros so para contar: `.select("*", { count: "exact", head: true })`
- **Usar agregacao via join** quando possivel: `.select("id, responses(count)")` ao inves de query separada
- **Paralelizar queries independentes** com `Promise.all()` — nunca fazer queries sequenciais que nao dependem uma da outra
- **Evitar N+1** — nunca fazer UPDATE/INSERT em loop. Usar `Promise.all()` para batch ou queries `.in()`
- **Fetch em 2 fases para dados pesados** — primeiro buscar metadados leves para filtrar, depois buscar campos pesados (ex: `text`) so do que precisa

### Componentes pesados
- **Lazy-load Monaco** via `dynamic()`
- **Nao adicionar dependencias pesadas** sem lazy-load (monaco, markdown renderers)
- **Manter `'use client'` o mais baixo possivel** na arvore de componentes

### Supabase indexes
- Queries frequentes com `.eq()` em colunas sem index devem ter index criado via migration
