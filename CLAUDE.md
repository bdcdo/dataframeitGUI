# dataframeitGUI

Plataforma web para analise de conteudo de documentos. Coordenadores definem perguntas (Pydantic), atribuem documentos a pesquisadores, rodam LLM. Pesquisadores codificam e revisam. Comparacoes automaticas quando ha N+ respostas para o mesmo documento.

## Arquitetura

```
Browser  →  Next.js 15 (Vercel)  ←→  Supabase (Postgres + Auth)
                |                            ^
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
| Auth + DB | Supabase (`@supabase/ssr`) | free tier |
| Backend LLM | FastAPI (Python) | latest |
| LLM | `dataframeit` | 0.5.3 |
| Editor | Monaco Editor (`@monaco-editor/react`) | latest |
| URL state | `nuqs` 2 | latest |
| Graficos | `recharts` | latest |
| Toast | `sonner` | latest |
| CSV | `papaparse` | latest |
| Brand color | teal #2F6868 = `oklch(0.44 0.08 185)` | - |

## Convencoes

- **Portugues** para UI (labels, mensagens), **ingles** para codigo (vars, funcs, types)
- **shadcn/ui** para todos os componentes de UI
- **Server Actions** para mutations, **RSC** para reads
- Supabase client: `lib/supabase/server.ts` (server) e `client.ts` (browser)
- **FastAPI** so para LLM e Pydantic (nao para CRUD)
- Testes: **Vitest** (frontend), **pytest** (backend)

## Estrutura

```
frontend/           # Next.js 15
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

Vercel faz deploy automatico a partir de push no branch `main`. Sempre que terminar uma tarefa, commitar e pushar para `main` para que o deploy aconteca. A unica excecao e quando o usuario **explicitamente pedir para criar uma branch separada** no inicio da tarefa — nesse caso, deixar na branch sem merge para main.

## Como rodar

```bash
# Frontend
cd frontend && npm run dev

# Backend
cd backend && uvicorn main:app --reload

# Supabase local
cd frontend && npx supabase start
```

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
