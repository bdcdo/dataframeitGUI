# Research: Pré-registro de membros e vínculo de múltiplos e-mails

**Feature**: `002-preregister-members` | **Data**: 2026-06-11

Nenhum NEEDS CLARIFICATION restou na spec (3 clarificações resolvidas em sessão). Este documento registra as decisões técnicas que estruturam o desenho, com alternativas consideradas.

## D1 — Placeholder de pré-registro: Supabase-only, sem criar usuário no Clerk

**Decisão**: o pré-registro cria apenas `auth.users` + `profiles` no Supabase (via admin client), sem chamar `clerk.users.createUser()`. A criação de usuário Clerk no `addMember()` atual (`frontend/src/actions/members.ts:51-80`) é removida.

**Rationale**: o fluxo atual cria um usuário Clerk "fantasma" para cada e-mail desconhecido, o que (a) polui o tenant Clerk, (b) já causou erro 422 `form_identifier_exists` em signups bloqueados por Turnstile (workaround nas linhas 55-66), e (c) torna a correção de e-mail de pendente uma operação em dois sistemas. O caminho de conflito de e-mail em `syncClerkUserToSupabase()` (`frontend/src/lib/clerk-sync.ts`) já resolve o cadastro posterior: quando a pessoa cria conta de verdade, o webhook `user.created` chama o sync, que detecta o e-mail existente em `auth.users` e mapeia o novo Clerk user para o profile placeholder — exatamente o auto-join exigido pelo FR-004.

**Alternativas consideradas**: (1) manter a criação de Clerk user (status quo) — rejeitada pelos problemas acima e porque o Clerk não envia convite nesse fluxo de qualquer forma (a spec dispensa e-mail); (2) usar Clerk Invitations API — rejeitada porque a spec decidiu explicitamente por pré-registro sem e-mail.

## D2 — Detecção de "pendente": coluna `profiles.activated_at`

**Decisão**: nova coluna `profiles.activated_at TIMESTAMPTZ NULL`. Pendente = `activated_at IS NULL`. É preenchida (uma única vez) em dois pontos: no webhook `user.created` ao sincronizar uma conta real, e pela action idempotente `completeAccess()` quando a tela de conclusão repara explicitamente um vínculo incompleto. `getAuthUser()` permanece read-only. Backfill da migration: `activated_at = created_at` para todos os profiles existentes.

**Rationale**: o sinal "tem conta real" não é derivável com segurança do estado atual — `clerk_user_mapping` existe também para placeholders antigos criados pelo fluxo vigente. Uma coluna explícita é barata, indexável e legível na query da lista de membros. O webhook cobre o fluxo normal; `completeAccess()` oferece reparo recuperável para contas pré-existentes ou eventual perda do webhook sem introduzir escrita no caminho de autenticação e renderização.

**Limitação aceita**: convidados antigos (criados pelo fluxo atual) que nunca acessaram serão backfillados como "ativos" — não há sinal local confiável para distingui-los; corrigir via Clerk `lastSignInAt` seria um script one-off fora do escopo.

**Alternativas consideradas**: (1) derivar pendência da ausência de `clerk_user_mapping` — falha para placeholders antigos que têm mapping; (2) consultar Clerk em runtime — chamada externa por render da lista, rejeitada por performance.

## D3 — Vínculo de e-mails: tabela única `member_email_links` com resolução por alias de projeto

**Decisão**: uma tabela `member_email_links (project_id, member_user_id, email, linked_user_id NULL, …)` serve simultaneamente de registro do vínculo e de alias. `member_user_id` é o membro-alvo (identidade canônica no projeto); `linked_user_id` é o profile da conta que usa aquele e-mail, preenchido quando a conta já existe ou no momento do signup (webhook). O schema garante uma única identidade canônica por `(linked_user_id, project_id)`, proíbe self-alias, exige que o target seja membro do mesmo projeto e impede que uma identidade seja simultaneamente alias e target; por isso a resolução é sempre de um único salto para um membro terminal. O acesso "como o membro" tem dois componentes: (a) RLS — os helpers de acesso, papel, `can_resolve` e own rows aplicam precedência da identidade canônica, sem somar a membership bruta; (b) aplicação — `getProjectAccessContext(projectId, user)` resolve identidade, projeto e papel num único contrato, enquanto `getEffectiveMemberId(projectId)` fica restrito a actions pessoais durante a migração dos callers.

**Rationale**: o caso "e-mail já pertence a outra conta" impede mapear o Clerk user direto para o profile do membro (isso seria merge global, descartado pela clarificação). O alias por projeto preserva os dois profiles globais e restringe a equivalência ao projeto — exatamente o FR-013. Usar uma única mecânica (sempre criar/usar o profile próprio da conta + alias) evita dois caminhos divergentes para "e-mail sem conta" vs "e-mail com conta". `getProjectAccessContext()` torna a distinção explícita: `accountUserId` identifica a conta autenticada em autoria e auditoria; `memberUserId` identifica a membership canônica em papel, permissões e trabalho do projeto.

**Alternativas consideradas**: (1) mapear o Clerk user do segundo e-mail diretamente para o profile do membro (`clerk_user_mapping` N:1) — simples, mas é merge global: a conta nova enxergaria todos os projetos do membro e quebraria o FR-013 no caso de conta pré-existente; rejeitada para manter mecânica única. (2) Duplicar `project_members` para a conta vinculada — quebraria a unicidade da identidade (contagens por `respondent_id`, comparações N+ e sorteio passariam a ver dois membros).

## D4 — Unificação de membros: função Postgres transacional via RPC

**Decisão**: função SQL `unify_project_members(p_project_id, p_source_user_id, p_target_user_id, p_acting_user_id)` SECURITY DEFINER, chamada via RPC pelo admin client num server action com checagem prévia de coordenador. Migra, no escopo do projeto, somente identidades de trabalho existentes no schema final: `assignments.user_id` (resolvendo colisões do `UNIQUE(document_id, user_id, type)` — a do alvo prevalece, a duplicada do source é removida), `responses.respondent_id` (recalculando `is_latest` após a fusão), `reviews.reviewer_id`, `verdict_acknowledgments.respondent_id`, `field_reviews.self_reviewer_id/arbitrator_id` e `response_equivalences.reviewer_id`; remove a preferência do source em `researcher_field_orders`, deleta sua linha de `project_members` e grava o alias source→target. Campos de ator/auditoria (`author_id`, `resolved_by`, `created_by`) permanecem ligados à conta que realizou o ato. Source e target são bloqueados em ordem determinística antes da revalidação, serializando unificações concorrentes sobre identidades sobrepostas. Alias prévio para o mesmo target é reutilizado; alias para target diferente ou colisão inesperada de e-mail aborta a transação antes de deixar estado parcial.

**Rationale**: são 10+ tabelas que precisam mudar atomicamente; server actions via PostgREST não têm transação multi-statement — uma função Postgres dá atomicidade e mantém a lógica de colisão num lugar só. A unificação é permanente (clarificação Q1), então não há estado de undo a persistir.

**Alternativas consideradas**: (1) sequência de UPDATEs no server action — sem atomicidade, estado parcial em caso de falha no meio; rejeitada. (2) View de "identidade efetiva" sem migrar dados — manteria dois respondent_ids para sempre e contaminaria todas as contagens (comparações, sorteio, progresso) com resolução de alias em cada query; rejeitada por complexidade difusa.

## D5 — Interação com a feature 001 (sorteio): nenhuma mudança necessária

**Decisão**: o sorteio (atual e o planejado em `specs/001-improve-assignment-lottery/`) seleciona o pool a partir de `project_members` — membros pendentes são linhas normais dessa tabela, logo são elegíveis automaticamente (FR-003) sem alteração no algoritmo. Único toque: exibir o badge "pendente" nas listas de seleção de pesquisadores do sorteio, para o coordenador saber quem ainda não acessou.

**Rationale**: o pré-registro foi desenhado de propósito como "membro comum + flag de ativação" para que todo o downstream (sorteio, atribuições, progresso) funcione sem casos especiais.

## D6 — Remoção de membro pendente: liberar atribuições pendentes

**Decisão**: `removeMember(memberId)` chama a RPC RLS `remove_project_member`, que deriva projeto e usuário da linha removível e deleta na mesma transação as `assignments` com `status = 'pendente'` e os aliases do membro. Vale para qualquer membro, não só pendentes; documentos voltam ao conjunto "não atribuído" por consequência, sem janela de estado parcial entre a remoção e a limpeza.

**Rationale**: FR-005 exige que as atribuições do pendente removido retornem ao pool; membros pendentes só podem ter atribuições `pendente` (nunca acessaram, não iniciaram trabalho), então deletá-las é seguro e idempotente.
