# dataframeitGUI

Plataforma web para análise de conteúdo com IA, baseada na lib dataframeit.

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

## Secret scanning

O repositório roda [gitleaks](https://github.com/gitleaks/gitleaks) em dois pontos: no CI (`.github/workflows/secret-scan.yml`, em todo PR e em push para `main`) e como hook de pre-commit local. Para habilitar o hook (uma vez por checkout):

```bash
pipx install pre-commit   # ou: uv tool install pre-commit
pre-commit install
```

A partir daí, cada commit é varrido em busca de segredos antes de entrarem no histórico.

## Deploy (Produção)

Produção roda inteiramente no **Fly.io** (`gru`), com deploy **automático por CI** a partir de merge na `main`: `backend/**` dispara `fly-deploy.yml` (app `gui-analise-sistematica-api`) e `frontend/**` dispara `frontend-fly-deploy.yml` (app `gui-analise-sistematica-frontend`). Domínio: `dataframeit.com.br`.

Se um deploy falhar, o workflow abre um incidente atribuído ao owner com a aplicação, o commit e o link da execução; novas falhas da mesma aplicação são adicionadas ao incidente aberto. Depois de confirmar a recuperação de produção, feche a issue para que uma falha futura abra outro incidente. Deploy verde não gera ruído.

### 1. Supabase Cloud

1. Criar projeto em [supabase.com](https://supabase.com)
2. Aplicar as migrations de `frontend/supabase/migrations/` (`npx supabase db push`)
3. Auth é via **Clerk** (não o Auth nativo do Supabase); o RLS valida o JWT do Clerk
4. Anotar: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`

### 2. Backend (Fly.io — `gui-analise-sistematica-api`)

Config em `backend/fly.toml`. Secrets de runtime via `fly secrets set` (nunca no toml):

```bash
cd backend
fly secrets set SUPABASE_URL=https://xxx.supabase.co \
  SUPABASE_SERVICE_KEY=your-key \
  CLERK_JWKS_URL='https://<slug>.clerk.accounts.dev/.well-known/jwks.json' \
  -a gui-analise-sistematica-api
# CORS_ORIGINS fica em [env] no fly.toml (origens permitidas, JSON array).
fly deploy -c fly.toml -a gui-analise-sistematica-api   # fallback; o normal é via CI
```

Verificar: `curl https://gui-analise-sistematica-api.fly.dev/health`

### 3. Frontend (Fly.io — `gui-analise-sistematica-frontend`)

Config em `frontend/fly.toml`. As `NEXT_PUBLIC_*` ficam em `[build.args]` (embutidas no bundle em build time, todas públicas por design); os secrets de runtime (`CLERK_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_WEBHOOK_SECRET`) via `fly secrets set`:

```bash
cd frontend
fly secrets set CLERK_SECRET_KEY=sk_... \
  SUPABASE_SERVICE_ROLE_KEY=your-key \
  CLERK_WEBHOOK_SECRET=whsec_... \
  -a gui-analise-sistematica-frontend
fly deploy -c fly.toml -a gui-analise-sistematica-frontend   # fallback; o normal é via CI
```

### Variáveis de ambiente

| Variável | Onde | Descrição |
|----------|------|-----------|
| `SUPABASE_URL` | Backend (Fly.io) | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | Backend (Fly.io) | Service role key |
| `CLERK_JWKS_URL` | Backend (Fly.io) | URL do JWKS do Clerk (verificação RS256 do JWT) |
| `CORS_ORIGINS` | Backend (`fly.toml [env]`) | JSON array de origens permitidas |
| `NEXT_PUBLIC_SUPABASE_URL` | Frontend (`fly.toml [build.args]`) | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend (`fly.toml [build.args]`) | Anon/publishable key |
| `NEXT_PUBLIC_API_URL` | Frontend (`fly.toml [build.args]`) | URL do backend no Fly.io |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Frontend (`fly.toml [build.args]`) | Publishable key do Clerk |
| `CLERK_SECRET_KEY` | Frontend (Fly secret) | Secret key do Clerk |
| `SUPABASE_SERVICE_ROLE_KEY` | Frontend (Fly secret) | Service role (server actions) |
| `CLERK_WEBHOOK_SECRET` | Frontend (Fly secret) | Signing secret do webhook do Clerk |

## Estrutura do Projeto

```
frontend/     # Next.js 15 + shadcn/ui + Tailwind v4
backend/      # FastAPI + dataframeit
docs/         # Especificacoes tecnicas
```
