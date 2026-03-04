# GUI Analise Sistematica

Plataforma web para analise sistematica de documentos, substituindo Google Forms + CLI.

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

## Deploy

- **Frontend:** Vercel
- **Backend:** Fly.io
- **Banco:** Supabase (free tier)

## Estrutura do Projeto

```
frontend/     # Next.js 15 + shadcn/ui + Tailwind v4
backend/      # FastAPI + dataframeit
docs/         # Especificacoes tecnicas
```
