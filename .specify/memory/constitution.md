<!--
Sync Impact Report
==================
Version change: 1.0.0 → 1.0.1 (emenda PATCH 2026-06-29)
Modified principles: n/a — sem mudança de princípio
Modified sections:
  - Restrições Adicionais → Stack fixada: removido `recharts` (dep órfã, sem
    import em src/; componentes VerdictChart/DailyPaceChart já removidos). PR #336.
  - Princípio II (Velocidade) → exemplo de lazy-load: removido `recharts` da lista.
Histórico anterior (ratificação 1.0.0):
Version change: template (sem versão) → 1.0.0 (ratificação inicial)
Modified principles: n/a (primeira adoção)
Added sections:
  - Core Principles (8 princípios: I–VIII)
  - Restrições Adicionais (stack, língua, desktop-first)
  - Workflow de Desenvolvimento
  - Governance
Removed sections: nenhuma (placeholders do template preenchidos)
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ compatível — seção "Constitution Check" é
    genérica ("Gates determined based on constitution file"); gates derivam deste arquivo
    em tempo de /speckit-plan, sem edição necessária
  - .specify/templates/spec-template.md ✅ compatível — sem referência conflitante
  - .specify/templates/tasks-template.md ✅ compatível — sem referência conflitante
Follow-up TODOs (dívidas declaradas, viram features futuras):
  - Criar workflow de CI rodando Vitest + pytest com coverage bloqueante (Princípio V)
  - Adotar gate de lint a11y — eslint-plugin-jsx-a11y ou equivalente (Princípio VI)
  - Migrar representação canônica do schema de código Pydantic para JSON declarativo
    (Princípios III e VII)
  - Diagnosticar e corrigir a lentidão atual da plataforma (Princípio II)
-->

# Constituição do dataframeitGUI

## Core Principles

### I. Usabilidade primeiro

A plataforma existe para *facilitar* a validação de extração de dados estruturados; uma feature que exige manual falhou no seu propósito. Toda funcionalidade MUST ser utilizável sem documentação externa: linguagem clara em pt-BR, affordances visíveis, estados vazios que explicam o próximo passo, feedback imediato para toda ação do usuário. Em tradeoff entre funcionalidade e clareza, clareza vence — uma feature poderosa mas confusa MUST ser simplificada ou cortada.

**Racional**: o público são pesquisadores e coordenadores de pesquisa, não desenvolvedores; a adoção da plataforma depende de ela ser auto-explicativa.

### II. Velocidade (prioridade altíssima)

Navegação e ações MUST parecer instantâneas. Lentidão reportada é bug, não melhoria — entra na fila com prioridade de bug. Budgets iniciais (ajustáveis por emenda PATCH):

- Transição de rota: p75 < 2s.
- Feedback visual de mutation (loading state ou optimistic UI): < 200ms.
- LCP nas páginas principais (lista de projetos, codificação, comparação): < 2,5s.

Regras de implementação não negociáveis (já praticadas no repositório, agora constitucionais):

- Queries Supabase com colunas explícitas — nunca `select("*")`.
- Nunca buscar todos os registros sem `limit()` em páginas com potencial de muitos dados.
- `count()` do Supabase em vez de buscar registros só para contar.
- Queries independentes paralelizadas com `Promise.all()`; nunca N+1 (UPDATE/INSERT em loop).
- Fetch em 2 fases para campos pesados (metadados primeiro, `text` depois, só do necessário).
- Lazy-load de dependências pesadas (Monaco, markdown renderers) via `dynamic()`.
- `'use client'` o mais baixo possível na árvore de componentes.

**Racional**: a experiência do usuário degrada de forma desproporcional com latência; a plataforma hoje está aquém do aceitável e a recuperação de velocidade é prioridade explícita do projeto.

### III. Segurança da informação

A plataforma processa dados de pesquisas ainda não publicadas, potencialmente sensíveis. Regras não negociáveis:

- **Least privilege**: a service key do Supabase MUST ser usada apenas em backend (FastAPI) e Server Actions; nunca exposta ao cliente. O cliente browser opera somente via JWT do Clerk + RLS.
- **Segredos** MUST viver exclusivamente em variáveis de ambiente (`.env.local`, secrets da plataforma de hosting); nunca em código versionado.
- **Não execução de código arbitrário de usuário**: a plataforma MUST caminhar para eliminar a compilação de código Python editável por usuário no backend. Direção registrada: migrar a representação canônica do schema de código Pydantic para JSON declarativo (ver Princípio VII). Enquanto a migração não ocorre, o `compile_pydantic` existente MUST ser tratado como superfície de ataque e endurecido a cada mudança.
- Dados de projeto MUST permanecer isolados entre projetos — vazamento cross-project é incidente de severidade máxima.

**Racional**: pesquisadores confiam à plataforma material inédito; uma violação compromete pesquisas inteiras e a confiança no produto.

### IV. RLS-por-padrão

Toda tabela nova MUST nascer, na mesma migration, com: RLS habilitado, policies por papel (coordenador/pesquisador, incluindo flags como `can_arbitrate`/`can_resolve` quando aplicável) e índices nas colunas usadas pelas policies (tipicamente `user_id` e `project_id`). Acesso que contorna RLS (service key) MUST ser pontual, justificado no código e restrito a operações que o RLS não cobre.

**Racional**: o RLS é a linha de defesa que vale mesmo quando a camada de aplicação erra; a maioria das migrations que criam tabelas já segue o padrão e ele é o mecanismo concreto do isolamento exigido pelo Princípio III.

### V. Robustez via testes

Código novo em `frontend/src/lib`, `frontend/src/actions`, `backend/services` e `backend/routes` MUST vir acompanhado de testes (Vitest no frontend, pytest no backend), e correção de bug MUST incluir teste de regressão que falhava antes da correção. Este requisito vale desde já e é verificado na revisão de PR.

O gate automatizado é meta declarada, ainda sem vigor: assim que existir workflow de CI rodando as suítes, todo PR MUST passar a suíte completa antes do merge, com coverage ≥ 80% de linhas nesses diretórios. Enquanto esse workflow não existe — os atuais só fazem deploy —, o bloqueio é manual: rodar as suítes localmente antes de abrir PR é obrigatório, e a revisão confere que os testes acompanham o código. Criar o workflow de CI é a primeira dívida a quitar pós-constituição.

**Racional**: a plataforma sustenta decisões de pesquisa; regressões silenciosas corrompem dados de codificação e comparações.

### VI. Acessibilidade WCAG 2.1 AA

A interface MUST atender WCAG 2.1 nível AA: navegação completa por teclado, contraste mínimo AA, atributos `aria-*` corretos, foco visível, formulários com labels associados. Componentes shadcn/ui já trazem a base; customizações MUST preservá-la.

*Dívida declarada*: adotar gate de lint de acessibilidade (`eslint-plugin-jsx-a11y` ou verificação equivalente no react-doctor).

**Racional**: acessibilidade é requisito de qualidade verificável, não cortesia; a norma nomeada (AA) torna o princípio testável. O foco desktop (ver Restrições Adicionais) não conflita — WCAG AA não exige suporte mobile.

### VII. Fonte única de verdade do schema

O schema de codificação tem uma única representação canônica, e toda propriedade de campo (`PydanticField`) MUST sobreviver ao round-trip completo UI → representação canônica → UI, sem depender de estado paralelo (é proibido reconstruir um campo apenas a partir do JSON em `projects.pydantic_fields`). Hoje a representação canônica é código Pydantic — as regras operacionais do CLAUDE.md (emitir em `generatePydanticCode()`, ler de volta em `compile_pydantic()`, atualizar primitivas de versionamento e diff de histórico) permanecem integralmente válidas. A direção constitucional é migrar a representação canônica para JSON declarativo, por segurança (Princípio III); qualquer migração MUST preservar o round-trip completo e o versionamento de mudanças (`schema_change_log`).

**Racional**: coordenadores editam o schema tanto pela GUI quanto pelo código; sem round-trip sem perdas, as duas vias divergem e dados de codificação ficam órfãos de definição.

### VIII. Simplicidade de stack

A arquitetura atual é suficiente e MUST ser defendida contra proliferação de camadas:

- FastAPI existe somente para LLM e compilação de schema — nunca para CRUD.
- Mutations via Server Actions; reads via RSC.
- Componentes de UI via shadcn/ui — não introduzir bibliotecas de componentes paralelas.
- Serviço, camada de abstração ou dependência pesada nova MUST ser justificada na seção Complexity Tracking do plan da feature, ou exigir emenda constitucional se alterar a arquitetura descrita aqui.

**Racional**: o projeto é mantido por uma equipe mínima em free tier; cada camada extra é custo permanente de manutenção, deploy e raciocínio.

## Restrições Adicionais

- **Stack fixada**: Next.js (App Router), React, TypeScript, Tailwind CSS, Clerk (auth), Supabase (Postgres + RLS, free tier), FastAPI (Python), dataframeit, Monaco, sonner, papaparse. A *escolha* de cada tecnologia é constitucional — trocar ou remover um item exige emenda. As *versões* exatas em vigor (Next 16, React 19, TS 5.7, Tailwind v4 etc.) vivem na tabela Tech Stack do `CLAUDE.md`: bumps de versão são detalhe operacional e não exigem emenda, desde que não alterem a arquitetura descrita aqui.
- **Língua**: pt-BR para toda a UI (labels, mensagens, toasts) e comunicação com usuários; inglês para código (variáveis, funções, types, nomes de arquivo).
- **Desktop-first explícito**: o alvo é desktop com mouse. Priorizar densidade de informação e alvos de clique para mouse — não aplicar mínimos de toque (44px). Não há obrigação de esforço contínuo de responsividade mobile/tablet, e features não devem ser limitadas para acomodar viewports pequenos; em contrapartida, não quebrar gratuitamente o uso em janelas menores de desktop.
- **Brand color**: teal `#2F6868` = `oklch(0.44 0.08 185)`.

## Workflow de Desenvolvimento

- Todo trabalho que modifica arquivos ocorre em git worktree própria com branch de feature criada a partir da `main` atualizada; nunca commitar direto na `main`.
- Todo merge na `main` passa por PR com revisão do usuário; merge pelo agente só com pedido explícito.
- Deploy é automático no merge da `main`, para frontend e backend; a plataforma de hosting vigente é detalhe operacional registrado no `CLAUDE.md`, não matéria constitucional.
- Migrations Supabase são aplicadas manualmente (`npx supabase db push`) — nunca rodam automaticamente no merge; verificar o estado real do banco antes de concluir que uma migration foi aplicada.
- Os gates de qualidade dos Princípios II (budgets de velocidade), V (testes/CI) e VI (a11y) são critérios de aceitação de PR.

## Governance

Esta constituição prevalece sobre práticas ad hoc e instruções informais; em conflito com outro documento do repositório, a constituição vence e o outro documento MUST ser corrigido.

**Emendas**: qualquer alteração deste arquivo ocorre via PR dedicado, com bump de versão semântica:

- **MAJOR**: remoção ou redefinição incompatível de princípio ou de regra de governança.
- **MINOR**: princípio ou seção nova, ou expansão material de orientação existente.
- **PATCH**: clarificações, ajustes de redação e de budgets numéricos sem mudança de semântica.

**Compliance**: o Constitution Check do `/speckit-plan` MUST validar cada feature contra os princípios I–VIII antes da fase de research e novamente após o design; violações que permanecem MUST ser justificadas na seção Complexity Tracking do plan. Revisões de PR verificam aderência aos princípios como parte do review.

O `CLAUDE.md` na raiz do repositório permanece como guia operacional de desenvolvimento (comandos, convenções de detalhe, performance); ele MUST manter-se consistente com esta constituição.

**Version**: 1.0.1 | **Ratified**: 2026-06-10 | **Last Amended**: 2026-06-29
