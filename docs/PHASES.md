# Roadmap de Implementacao

## Fase 0 — Documentacao Fundacional ✅
Criar CLAUDE.md, README.md, docs/*.md

## Fase 1 — Scaffold + Design System
**Objetivo:** Next.js rodando com visual correto.
**Arquivos:** package.json, next.config.ts, globals.css, layout.tsx, components.json, Header, ProjectTabs, UserMenu, backend/main.py
**Verificacao:** `pnpm dev` renderiza shell com cor teal e tabs.
**Status:** Pendente

## Fase 2 — Supabase + Auth
**Objetivo:** Login funcional, banco criado.
**Arquivos:** config.toml, 001_initial_schema.sql, supabase clients, middleware, login page, callback
**Verificacao:** Login via magic link -> redirect -> dashboard vazio.
**Status:** Pendente

## Fase 3 — Projetos + Membros
**Objetivo:** CRUD de projetos funcional.
**Arquivos:** actions/projects.ts, members.ts, types.ts, dashboard page, member components
**Verificacao:** Criar projeto, adicionar membro, ver na lista.
**Status:** Pendente

## Fase 4 — Documentos + Upload CSV
**Objetivo:** Upload e visualizacao de documentos.
**Arquivos:** actions/documents.ts, DocumentList, DocumentUpload, DocumentPreview
**Verificacao:** Upload CSV -> documentos listados, preview funciona.
**Status:** Pendente

## Fase 5 — Atribuicoes + Sorteio
**Objetivo:** Atribuir documentos a pesquisadores.
**Arquivos:** actions/assignments.ts, AssignmentTable, RandomizeDialog
**Verificacao:** Sortear 2 pesq/doc -> tabela preenchida, editar clicando.
**Status:** Pendente

## Fase 6 — Editor Pydantic + Prompt
**Objetivo:** Coordenador define schema e prompt.
**Arquivos:** actions/schema.ts, PydanticEditor, PromptEditor, ValidationStatus, api.ts, pydantic_routes.py, pydantic_compiler.py
**Verificacao:** Colar Pydantic -> validar -> campos parseados -> salvar.
**Status:** Pendente

## Fase 7 — Codificacao Humana
**Objetivo:** Pesquisador codifica documentos.
**Arquivos:** actions/responses.ts, CodingPage, DocumentReader, QuestionBanner, ProgressDots, FieldRenderer, DocumentNav
**Verificacao:** Responder perguntas, auto-save, navegacao funcional.
**Status:** Pendente

## Fase 8 — Classificacao LLM
**Objetivo:** Coordenador roda LLM.
**Arquivos:** LlmControl, llm page, llm_routes.py, llm_runner.py, supabase_client.py
**Verificacao:** Rodar LLM -> respostas salvas. Alterar Pydantic -> desatualizadas.
**Status:** Pendente

## Fase 9 — Comparacao + Revisao
**Objetivo:** Interface de revisao funcional.
**Arquivos:** actions/reviews.ts, ComparePage, ResponseCard, VerdictPanel, CompareFilter, KeyboardShortcuts
**Verificacao:** Divergencias -> comparacao -> veredito com atalhos.
**Status:** Pendente

## Fase 10 — Stats + Export
**Objetivo:** Dashboard e exportacao.
**Arquivos:** StatsOverview, FieldProgress, VerdictChart, ExportPage
**Verificacao:** Stats refletem dados. CSV exportado valido.
**Status:** Pendente
