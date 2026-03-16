# GUI Analise de Conteudo

Plataforma web para analise de conteudo de documentos, substituindo Google Forms + CLI.

## Funcionalidades

- **Coordenadores:** definem perguntas via Pydantic, atribuem documentos, configuram e rodam LLM
- **Pesquisadores:** codificam documentos respondendo perguntas, revisam divergencias
- **Comparacao automatica:** quando N+ respostas existem para um documento, divergencias sao identificadas
- **Classificacao LLM:** usa `dataframeit` para classificar documentos automaticamente
- **Exportacao:** CSV e Markdown

## Arquitetura

- **Next.js 15** (App Router) — frontend + Server Actions
- **Supabase** — Postgres + Auth (Row Level Security)
- **FastAPI** — backend leve para LLM e validacao Pydantic

## Instalacao

### Frontend

```bash
cd frontend
pnpm install
cp .env.example .env.local  # configurar SUPABASE_URL e SUPABASE_ANON_KEY
pnpm dev
```

### Backend

```bash
cd backend
uv sync
cp .env.example .env  # configurar SUPABASE_URL e SUPABASE_SERVICE_KEY
uvicorn main:app --reload
```

### Supabase Local

```bash
cd frontend
npx supabase start
npx supabase db push
```

## Deploy (Produção)

### 1. Supabase Cloud

1. Criar projeto em [supabase.com](https://supabase.com)
2. Rodar `frontend/supabase/migrations/001_initial_schema.sql` no SQL Editor
3. Em Auth → Settings: habilitar email/password, setar Site URL para o domínio Vercel
4. Anotar: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`

### 2. Backend (Fly.io)

```bash
cd backend
fly apps create gui-analise-conteudo-api
fly secrets set SUPABASE_URL=https://xxx.supabase.co \
  SUPABASE_SERVICE_KEY=your-key \
  CORS_ORIGINS='["https://seu-dominio.vercel.app"]'
fly deploy
```

Verificar: `curl https://gui-analise-conteudo-api.fly.dev/health`

### 3. Frontend (Vercel)

```bash
cd frontend
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL     # https://xxx.supabase.co
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add NEXT_PUBLIC_API_URL           # https://gui-analise-conteudo-api.fly.dev
vercel --prod
```

### Variáveis de ambiente

| Variável | Onde | Descrição |
|----------|------|-----------|
| `SUPABASE_URL` | Backend (Fly.io) | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | Backend (Fly.io) | Service role key |
| `CORS_ORIGINS` | Backend (Fly.io) | JSON array de origens permitidas |
| `NEXT_PUBLIC_SUPABASE_URL` | Frontend (Vercel) | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend (Vercel) | Anon/public key |
| `NEXT_PUBLIC_API_URL` | Frontend (Vercel) | URL do backend no Fly.io |

## Estrutura do Projeto

```
frontend/     # Next.js 15 + shadcn/ui + Tailwind v4
backend/      # FastAPI + dataframeit
docs/         # Especificacoes tecnicas
```
