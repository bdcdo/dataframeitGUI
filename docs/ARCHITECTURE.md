# Arquitetura

## Diagrama

```
Browser
  |
  v
Next.js 15 (Vercel)  <-->  Supabase (Postgres + Auth)
  |                                ^
  | HTTP (so LLM + Pydantic)       |
  v                                |
FastAPI (Fly.io)  ---------------> |
  |-- dataframeit             (service key)
  |-- Pydantic compiler
```

## Responsabilidades

### Next.js 15 (Frontend)
- UI completa com shadcn/ui + Tailwind v4
- Server Actions para mutations (CRUD via Supabase)
- RSC para reads (queries Supabase direto no servidor)
- Auth via `@supabase/ssr`

### Supabase
- Postgres com Row Level Security
- Auth (magic link / OAuth)
- Free tier

### FastAPI (Backend leve)
- Compila codigo Pydantic (exec + extracao de campos)
- Roda `dataframeit` (classificacao LLM)
- Acessa Supabase via service key (bypassa RLS)
- NAO faz CRUD — isso e responsabilidade do Next.js

## Fluxos Principais

### Setup de projeto
1. Coordenador cria projeto no dashboard
2. Adiciona membros por email
3. Upload CSV de documentos
4. Define schema Pydantic no editor Monaco
5. Valida Pydantic via FastAPI
6. Configura prompt template
7. Sorteia atribuicoes

### Codificacao
1. Pesquisador abre /code
2. Ve documento atribuido + pergunta atual
3. Responde pergunta (radio, checkbox, textarea)
4. Auto-save ao navegar
5. Ao completar todas as perguntas, assignment -> concluido

### Classificacao LLM
1. Coordenador clica "Rodar LLM"
2. Next.js chama FastAPI POST /api/llm/run
3. FastAPI le projeto + docs do Supabase
4. Roda dataframeit em batch
5. Salva respostas com respondent_type='llm' e pydantic_hash
6. Frontend faz polling de progresso

### Invalidacao LLM
1. Coordenador altera Pydantic e salva
2. Novo hash calculado: sha256(code)[:16]
3. Respostas LLM com hash antigo: is_current = false
4. UI mostra badge "Desatualizada"
5. Coordenador pode re-rodar campos afetados

### Comparacao
1. Query identifica campos com respostas divergentes
2. Para cada campo: mostra cards de cada respondente
3. Revisor escolhe veredito (1-9, ambiguo, pular)
4. Veredito salvo em reviews
5. Avanca automaticamente
