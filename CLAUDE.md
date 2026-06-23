# dataframeitGUI

Plataforma web para analise de conteudo de documentos. Coordenadores definem perguntas (Pydantic), atribuem documentos a pesquisadores, rodam LLM. Pesquisadores codificam e revisam. Comparacoes automaticas quando ha N+ respostas para o mesmo documento.

Documento normativo do projeto: `.specify/memory/constitution.md` (constituicao v1.0.0 — principios de usabilidade, velocidade, seguranca, RLS, testes, a11y, schema e simplicidade de stack). Em conflito, a constituicao prevalece sobre este guia.

## Arquitetura

```
Browser  →  Next.js 16 (Vercel)  ←→  Supabase (Postgres + RLS)
                |                            ^
                | Clerk (Auth + JWT)         |
                | HTTP (LLM + Pydantic)      |
                v                            |
            FastAPI (Fly.io)  ───────────────┘
              |-- dataframeit           (service key)
              |-- Pydantic compiler
```

## Tech Stack

| Camada | Tecnologia | Versao |
|--------|-----------|--------|
| Frontend | Next.js (App Router) | 16 |
| UI | React 19 + shadcn/ui (new-york, neutral) | latest |
| Linguagem | TypeScript | 5.7 |
| Styling | Tailwind CSS v4 (oklch) | 4 |
| Auth | Clerk (`@clerk/nextjs`) + `@clerk/localizations` (pt-BR) | latest |
| DB | Supabase (Postgres + RLS via Clerk JWT) | free tier |
| Backend LLM | FastAPI (Python) | latest |
| LLM | `dataframeit` | 0.5.3 |
| Editor | Monaco Editor (`@monaco-editor/react`) | latest |
| Graficos | `recharts` | latest |
| Toast | `sonner` | latest |
| CSV | `papaparse` | latest |
| Brand color | teal #2F6868 = `oklch(0.44 0.08 185)` | - |

## Convencoes

- **Portugues** para UI (labels, mensagens), **ingles** para codigo (vars, funcs, types)
- **Alvo e desktop/mouse, nao toque**: a plataforma e acessada via computador. Otimizar densidade e alvos de clique para mouse — nao aplicar o minimo de 44px de toque. Em caso de tradeoff, priorizar densidade de informacao.
- **shadcn/ui** para todos os componentes de UI
- **Server Actions** para mutations, **RSC** para reads
- Auth: Clerk (`lib/auth.ts` para `getAuthUser()`, `lib/clerk-sync.ts` para sync Clerk↔Supabase)
- Supabase client: `lib/supabase/server.ts` (server, autenticado via Clerk JWT) e `lib/supabase/admin.ts` (service key)
- **FastAPI** so para LLM e Pydantic (nao para CRUD)
- **EditFieldDialog**: toda config de schema acessivel na aba Schema deve ser igualmente acessivel via `EditFieldDialog` inline (Comentarios e LLM Insights). Ao adicionar um campo novo a `PydanticField`, garantir que ambos os editores (FieldCard e EditFieldDialog) o exponham.
- **Pydantic = fonte de verdade do schema**: toda propriedade de `PydanticField` (definida em `frontend/src/lib/types.ts`) deve ser transportada no codigo Pydantic gerado — via annotation, `Field(...)` ou `json_schema_extra={...}`. E proibido depender apenas do JSON em `projects.pydantic_fields` para reconstruir um campo. Motivo: permitir que coordenadores editem o codigo Pydantic direto sem perder informacao, alem de garantir round-trip completo `UI -> pydantic_code -> compile_pydantic -> UI`. Ao adicionar um campo novo a `PydanticField`, atualize:
  - (a) `generatePydanticCode()` em `frontend/src/lib/schema-utils.ts` para emitir a propriedade;
  - (b) `compile_pydantic()` em `backend/services/pydantic_compiler.py` para le-la de volta;
  - (c) as primitivas de versionamento/auditoria em `frontend/src/lib/schema-utils.ts` — `snapshotOf`, `classifyChange`, `diffFields`, `fieldDiffIsStructural` — para que a mudanca da propriedade seja classificada (minor/patch) e registrada em `schema_change_log`. Essas primitivas sao puras e compartilhadas entre `saveSchemaFromGUI` e scripts fora do Next runtime, justamente para evitar drift (ver #63);
  - (d) o diff de historico em `frontend/src/lib/schema-change-utils.ts` (`FieldPropertyDiff`, `diffPydanticField`, `PROPERTY_LABELS`) e o renderizador `FieldChangeDiff.tsx`.

  **Direcao registrada (constituicao, Principios III e VII)**: por seguranca, a representacao canonica do schema deve migrar de codigo Pydantic (Python compilado no backend a partir de texto editavel por usuario) para JSON declarativo. Ate essa migracao acontecer, todas as regras (a)–(d) acima valem integralmente; qualquer migracao deve preservar o round-trip completo e o versionamento em `schema_change_log`.
- Testes: **Vitest** (frontend), **pytest** (backend)

## Estrutura

```
frontend/           # Next.js 16
  src/
    app/            # App Router pages
    components/     # UI components (shell, coding, compare, schema, etc.)
    actions/        # Server Actions
    lib/            # Supabase clients, types, utils
  supabase/
    migrations/     # SQL migrations

backend/            # FastAPI
  routes/           # API endpoints
  services/         # Business logic (pydantic_compiler, llm_runner)
```

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

Deploy e automatico a partir de merge no branch `main`. Frontend: em migracao Vercel → Fly.io (app `gui-analise-sistematica-frontend`); enquanto o cutover de dominio nao ocorre, Vercel ainda e a producao. Backend: Fly.io (app `gui-analise-sistematica-api`) via workflow quando ha mudanca em `backend/**`. A partir de 2026-04-20, **sempre criar branch + PR** em vez de push direto na main. Fluxo:

1. **Criar git worktree isolado** para a tarefa (ver secao "Workspace isolado" abaixo) — nao trabalhar no diretorio principal
2. Criar branch descritiva (`feat/...`, `fix/...`, `perf/...`) na worktree
3. Commitar nela
4. Ao final, abrir PR contra `main` via `gh pr create`
5. Deixar o usuario revisar o PR
6. Remover a worktree apos o merge

Nunca fazer push direto para `main`. Merge do PR pode ser feito pelo Claude quando o usuario pedir explicitamente.

## Workspace isolado (worktree)

**Sempre trabalhar em git worktree separado**, nunca no diretorio principal. Motivo: o usuario pode continuar trabalhando em outra branch no diretorio principal em paralelo. Se Claude usar `git checkout` para trocar de branch ali, sobrescreve o working tree do usuario; e se o usuario trocar a branch enquanto Claude edita, os arquivos editados ficam "perdidos" no historico de outra branch.

Criar a worktree no inicio da tarefa:

```bash
git worktree add ../worktrees/<descricao-curta> -b <branch-name>
cd ../worktrees/<descricao-curta>
```

Trabalhar la (todos os edits, commits, push, `gh pr create`). Apos o merge do PR:

```bash
cd /home/brunodcdo/Desktop/dev/2026/38_GUIAnaliseSistematica
git worktree remove ../worktrees/<descricao-curta>
```

Excecao: tarefas read-only puras (responder duvida, ler codigo, explicar arquitetura) podem ser feitas no diretorio principal sem worktree.

## Como rodar

```bash
# Frontend
cd frontend && npm run dev

# Backend
cd backend && uvicorn main:app --reload

# Supabase local
cd frontend && npx supabase start

# Lint / qualidade React (react-doctor)
cd frontend && npm run lint
cd frontend && npm run react-doctor        # scan completo
cd frontend && npm run react-doctor:diff   # só arquivos alterados vs main
```

O **react-doctor** é um linter pinado (`react-doctor@0.5.8`, devDependency) com config em `frontend/doctor.config.json` (fonte única; na 0.5.x o nome do arquivo passou a ser `doctor.config.*`). Um hook **local de pre-commit** (`.pre-commit-config.yaml`) roda `react-doctor . --scope changed --base HEAD --blocking error` nos commits que tocam `frontend/**/*.{ts,tsx}`: **bloqueia só se a linha alterada produzir um error** (`--scope changed` é line-scoped; substituiu o `--diff` deprecado na 0.5.7); o débito legado de errors/warnings fica grandfathered. Setup (1x): `uv tool install pre-commit && pre-commit install` (requer `npm install` em `frontend/`). Por ser local e opt-in, é uma rede de proteção do dev — não um portão de merge no servidor. Detalhes, baseline 0.5.8 e regras silenciadas em `docs/LINT_CONFIG.md`.

## Scripts one-off de dados / específicos de projeto

Scripts pontuais que operam sobre os dados de **um projeto específico** (dedup, correção de import, migração de dados ad hoc, re-OCR) **não vão para o repositório geral**: vivem em `pipeline-processos/` (gitignored), junto dos outros utilitários locais do Zolgensma. Motivo: carregam IDs e suposições de um projeto/dataset, não são reutilizáveis nem revisáveis como código de produto, e versioná-los polui o repo e expõe dados do banco (backups). Quando precisar resolver o `.env.local`, use caminho canônico do `frontend/` ou a env var `SUPABASE_ENV_PATH` — nunca suba a árvore de diretórios.

Vai para o repo (PR normal) só a **correção de causa raiz genérica** que decorre desse trabalho — migration, mudança de comportamento no app, teste. Exemplo concreto (2026-06-23): as duplicatas de `documents` por re-import (projetos Zolgensma `0c6394da` e Zolgensma-Judiciário `00779233`) foram resolvidas por scripts locais em `pipeline-processos/dedup/`; o que entrou no repo foi a **migration do índice único parcial** `documents_project_external_id_active_uniq` (`UNIQUE(project_id, external_id) WHERE external_id IS NOT NULL AND excluded_at IS NULL`) + o **filtro defensivo** `filterActiveExternalIdConflicts` em `uploadDocuments`, que pula external_ids já ativos ou repetidos no lote em vez de deixar o INSERT em lote falhar inteiro.

## Performance — Regras de Arquitetura

Seguir estas regras para evitar regressoes de performance:

### Queries Supabase
- **Nunca usar `.select("*")`** — sempre listar colunas explicitas (ex: `.select("id, title, created_at")`)
- **Nunca buscar todos os registros sem `.limit()`** em paginas que podem ter muitos dados
- **Usar `count()` do Supabase** ao inves de buscar registros so para contar: `.select("*", { count: "exact", head: true })`
- **Usar agregacao via join** quando possivel: `.select("id, responses(count)")` ao inves de query separada
- **Paralelizar queries independentes** com `Promise.all()` — nunca fazer queries sequenciais que nao dependem uma da outra
- **Evitar N+1** — nunca fazer UPDATE/INSERT em loop. Usar `Promise.all()` para batch ou queries `.in()`
- **Fetch em 2 fases para dados pesados** — primeiro buscar metadados leves para filtrar, depois buscar campos pesados (ex: `text`) so do que precisa

### Componentes pesados
- **Lazy-load recharts** via `dynamic(() => import("recharts").then(...), { ssr: false })` — nunca importar recharts diretamente. Ver `VerdictChart.tsx` e `DailyPaceChart.tsx` como referencia
- **Lazy-load Monaco** via `dynamic()` — ja feito corretamente
- **Nao adicionar dependencias pesadas** sem lazy-load (recharts, monaco, markdown renderers)
- **Manter `'use client'` o mais baixo possivel** na arvore de componentes

### Supabase indexes
- Toda nova tabela que participa de RLS precisa de index nas colunas usadas por `auth_user_project_ids()` (tipicamente `user_id` e `project_id`)
- Queries frequentes com `.eq()` em colunas sem index devem ter index criado via migration

## Fase atual: 10 - Todas as fases implementadas (scaffold completo)

Ver `docs/PHASES.md` para roadmap completo.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure, shell commands, and other important information, read the current plan: `specs/002-preregister-members/plan.md` (feature ativa; artefatos em `specs/002-preregister-members/`).
<!-- SPECKIT END -->
