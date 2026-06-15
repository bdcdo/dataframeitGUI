# Research: Pré-registro de membros e vínculo de múltiplos e-mails

**Feature**: `002-preregister-members` | **Data**: 2026-06-11

Nenhum NEEDS CLARIFICATION restou na spec (3 clarificações resolvidas em sessão). Este documento registra as decisões técnicas que estruturam o desenho, com alternativas consideradas.

## D1 — Placeholder de pré-registro: Supabase-only, sem criar usuário no Clerk

**Decisão**: o pré-registro cria apenas `auth.users` + `profiles` no Supabase (via admin client), sem chamar `clerk.users.createUser()`. A criação de usuário Clerk no `addMember()` atual (`frontend/src/actions/members.ts:51-80`) é removida.

**Rationale**: o fluxo atual cria um usuário Clerk "fantasma" para cada e-mail desconhecido, o que (a) polui o tenant Clerk, (b) já causou erro 422 `form_identifier_exists` em signups bloqueados por Turnstile (workaround nas linhas 55-66), e (c) torna a correção de e-mail de pendente uma operação em dois sistemas. O caminho de conflito de e-mail em `syncClerkUserToSupabase()` (`frontend/src/lib/clerk-sync.ts`) já resolve o cadastro posterior: quando a pessoa cria conta de verdade, o webhook `user.created` chama o sync, que detecta o e-mail existente em `auth.users` e mapeia o novo Clerk user para o profile placeholder — exatamente o auto-join exigido pelo FR-004.

**Alternativas consideradas**: (1) manter a criação de Clerk user (status quo) — rejeitada pelos problemas acima e porque o Clerk não envia convite nesse fluxo de qualquer forma (a spec dispensa e-mail); (2) usar Clerk Invitations API — rejeitada porque a spec decidiu explicitamente por pré-registro sem e-mail.

## D2 — Detecção de "pendente": coluna `profiles.activated_at`

**Decisão**: nova coluna `profiles.activated_at TIMESTAMPTZ NULL`. Pendente = `activated_at IS NULL`. É preenchida (uma única vez) em dois pontos: no webhook `user.created` ao sincronizar uma conta real, e como fallback em `getAuthUser()` (`frontend/src/lib/auth.ts`) na primeira request autenticada cujo profile ainda esteja com `activated_at IS NULL`. Backfill da migration: `activated_at = created_at` para todos os profiles existentes.

**Rationale**: o sinal "tem conta real" não é derivável com segurança do estado atual — `clerk_user_mapping` existe também para placeholders antigos criados pelo fluxo vigente. Uma coluna explícita é barata, indexável e legível na query da lista de membros. O fallback em `getAuthUser()` cobre contas pré-existentes e eventual perda de webhook.

**Limitação aceita**: convidados antigos (criados pelo fluxo atual) que nunca acessaram serão backfillados como "ativos" — não há sinal local confiável para distingui-los; corrigir via Clerk `lastSignInAt` seria um script one-off fora do escopo.

**Alternativas consideradas**: (1) derivar pendência da ausência de `clerk_user_mapping` — falha para placeholders antigos que têm mapping; (2) consultar Clerk em runtime — chamada externa por render da lista, rejeitada por performance.

## D3 — Vínculo de e-mails: tabela única `member_email_links` com resolução por alias de projeto

**Decisão**: uma tabela `member_email_links (project_id, member_user_id, email, linked_user_id NULL, …)` serve simultaneamente de registro do vínculo e de alias. `member_user_id` é o membro-alvo (identidade canônica no projeto); `linked_user_id` é o profile da conta que usa aquele e-mail, preenchido quando a conta já existe ou no momento do signup (webhook). O acesso "como o membro" tem dois componentes: (a) RLS — `auth_user_accessible_project_ids()` passa a incluir projetos onde `linked_user_id = clerk_uid()`, e as policies de "own rows" (responses, field_reviews) aceitam o id canônico quando há alias; (b) aplicação — helper `getEffectiveMemberId(projectId)` resolve o id canônico e substitui `user.id` nas queries/mutations de trabalho do projeto (coding, my-progress, responses).

**Rationale**: o caso "e-mail já pertence a outra conta" impede mapear o Clerk user direto para o profile do membro (isso seria merge global, descartado pela clarificação). O alias por projeto preserva os dois profiles globais e restringe a equivalência ao projeto — exatamente o FR-013. Usar uma única mecânica (sempre criar/usar o profile próprio da conta + alias) evita dois caminhos divergentes para "e-mail sem conta" vs "e-mail com conta"; o padrão `effectiveUserId` já existe no código (impersonação master em `analyze/code/page.tsx`), o que reduz o custo de adoção.

**Alternativas consideradas**: (1) mapear o Clerk user do segundo e-mail diretamente para o profile do membro (`clerk_user_mapping` N:1) — simples, mas é merge global: a conta nova enxergaria todos os projetos do membro e quebraria o FR-013 no caso de conta pré-existente; rejeitada para manter mecânica única. (2) Duplicar `project_members` para a conta vinculada — quebraria a unicidade da identidade (contagens por `respondent_id`, comparações N+ e sorteio passariam a ver dois membros).

## D4 — Unificação de membros: função Postgres transacional via RPC

**Decisão**: função SQL `unify_project_members(p_project_id, p_source_user_id, p_target_user_id)` SECURITY DEFINER, chamada via RPC pelo admin client num server action com checagem prévia de coordenador. Migra, no escopo do projeto, todas as colunas de identidade mapeadas: `assignments.user_id` (resolvendo colisões do `UNIQUE(document_id, user_id, type)` — a do alvo prevalece, a duplicada do source é removida), `responses.respondent_id` (recalculando `is_latest` por documento após a fusão), `reviews.reviewer_id/resolved_by`, `field_reviews.self_reviewer_id/arbitrator_id`, `project_comments.author_id/resolved_by`, `difficulty_resolutions/error_resolutions/note_resolutions.resolved_by`, `response_equivalences.reviewer_id`, `llm_runs.started_by`, `assignment_batches.created_by`; remove a linha de `project_members` do source (papel/permissões do alvo prevalecem, conforme spec) e grava o alias source→target em `member_email_links`.

**Rationale**: são 10+ tabelas que precisam mudar atomicamente; server actions via PostgREST não têm transação multi-statement — uma função Postgres dá atomicidade e mantém a lógica de colisão num lugar só. A unificação é permanente (clarificação Q1), então não há estado de undo a persistir.

**Alternativas consideradas**: (1) sequência de UPDATEs no server action — sem atomicidade, estado parcial em caso de falha no meio; rejeitada. (2) View de "identidade efetiva" sem migrar dados — manteria dois respondent_ids para sempre e contaminaria todas as contagens (comparações, sorteio, progresso) com resolução de alias em cada query; rejeitada por complexidade difusa.

## D5 — Interação com a feature 001 (sorteio): nenhuma mudança necessária

**Decisão**: o sorteio (atual e o planejado em `specs/001-improve-assignment-lottery/`) seleciona o pool a partir de `project_members` — membros pendentes são linhas normais dessa tabela, logo são elegíveis automaticamente (FR-003) sem alteração no algoritmo. Único toque: exibir o badge "pendente" nas listas de seleção de pesquisadores do sorteio, para o coordenador saber quem ainda não acessou.

**Rationale**: o pré-registro foi desenhado de propósito como "membro comum + flag de ativação" para que todo o downstream (sorteio, atribuições, progresso) funcione sem casos especiais.

## D6 — Remoção de membro pendente: liberar atribuições pendentes

**Decisão**: `removeMember()` passa a deletar as `assignments` com `status = 'pendente'` do usuário removido no projeto (vale para qualquer membro, não só pendentes — comportamento hoje inexistente; atribuições órfãs permanecem). Documentos voltam ao conjunto "não atribuído" por consequência (não há estado a restaurar).

**Rationale**: FR-005 exige que as atribuições do pendente removido retornem ao pool; membros pendentes só podem ter atribuições `pendente` (nunca acessaram, não iniciaram trabalho), então deletá-las é seguro e idempotente.
