# Quickstart: validar pré-registro e vínculo de e-mails

**Feature**: `002-preregister-members`

## Setup

```bash
cd frontend
npx supabase start
npx supabase db reset
npm run dev
```

O quickstart valida somente o banco local. Aplicar migrations ao ambiente remoto é uma operação manual separada, feita depois da aprovação pelo procedimento operacional do projeto; nenhum comando de publicação remota faz parte deste roteiro. A integridade da autoria LLM já vem da `main` em `20260716154500_responses_llm_actor_integrity.sql`. No rollout, o bloco pendente deste PR — `20260716160000_canonical_project_identity_rls.sql`, `20260716160100_prevent_self_arbitration.sql`, `20260716160200_sync_auto_review_assignment_status.sql` e `20260716160300_auto_review_assignment_integrity.sql` — precisa chegar, nessa ordem, antes do frontend que consulta os markers e chama as RPCs novas. O `db push --dry-run` deve listar exatamente essas quatro migrations, sem `--include-all`; publicar a aplicação primeiro fecha o acesso com erro técnico por contrato, em vez de operar contra um schema antigo.

São necessárias 2+ contas de e-mail de teste (aliases Gmail `+sufixo` funcionam no Clerk dev).

## US1 — Pré-registro (P1)

1. Como coordenador, em `/projects/<id>/config/members`, adicionar um e-mail que nunca criou conta → linha aparece com badge **Pendente**.
2. Rodar o sorteio (ou atribuição manual) incluindo o pendente → atribuições criadas normalmente.
3. Corrigir o e-mail do pendente (ação de editar) → e-mail atualizado.
4. Em janela anônima, criar conta no Clerk com o e-mail pré-registrado → no primeiro acesso, o projeto aparece na home e as atribuições em "minhas análises"; badge some da lista de membros (recarregar como coordenador).
5. Remover um pendente com atribuições → atribuições `pendente` somem do documento (volta ao pool do sorteio).

## US2 — Vínculo de e-mails (P2)

1. Num membro existente, "Vincular e-mail" com um e-mail **sem conta** → aparece como e-mail adicional na lista.
2. Criar conta com esse segundo e-mail → a conta nova vê o projeto e exatamente as mesmas atribuições do membro (acessa "como" ele); fora do projeto, conta independente. Se o profile canônico ainda estava pendente, o badge "Pendente" some apenas neste projeto porque a lista detecta o alias ativo; o `activated_at` canônico permanece inalterado.
3. Vincular um e-mail que **já é outro membro do mesmo projeto** → diálogo de unificação com cinco contagens (atribuições migradas, docs com resposta de ambos, colisões de review, conflitos de arbitragem e conflitos de comparação) e papel resultante. Sem conflitos, confirmar → a lista mostra um membro só, atribuições somadas e respostas preservadas. Com qualquer conflito, a confirmação permanece bloqueada e nenhum histórico é descartado.
4. Tentar vincular e-mail já vinculado a outro membro → erro indicando o membro.
5. Desvincular o e-mail adicional → conta do e-mail perde acesso ao projeto; histórico do membro intacto.

## Clerk — autoridade e revogação fail-closed

1. Numa conta com alias resolvido, remover o endereço verificado ou deixar a conta sem primário verificado; disparar `user.updated` ou usar a conclusão de acesso → a conta perde o alias e não recebe `AuthUser` enquanto o estado não voltar a ser válido.
2. Excluir a conta Clerk e entregar `user.deleted` → o mapping fica revogado e o alias perde acesso; repetir o evento é idempotente.
3. Entregar primeiro uma geração nova e depois simular snapshot antigo → somente a geração atual pode concluir; o evento antigo não restaura aliases nem metadata.
4. Confirmar que `profiles.email` sozinho não concede `ready`: um profile ativo sem dono atual confirmado no Clerk falha fechado.

## Testes automatizados

```bash
cd frontend
npm test -- --run src/actions/__tests__/members.test.ts src/lib/__tests__/clerk-primary-email.test.ts src/lib/__tests__/clerk-sync.test.ts src/components/members/__tests__/LinkEmailDialog.test.tsx src/components/members/__tests__/UnifyMembersDialog.test.tsx src/components/members/__tests__/member-list-utils.test.ts
for file in supabase/tests/*.test.sql; do docker exec -i supabase_db_frontend psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$file" || exit 1; done
```

Pontos críticos a cobrir: colisões de assignment/review/arbitragem/comparação na unificação; `linkEmail` revalidado; RLS — conta vinculada lê apenas o projeto vinculado e perde mutação histórica quando a membership termina; cascade de aliases ao remover membership; snapshot em duas fases, geração superseded, ausência de primário e `user.deleted`; separação entre `profileByEmail` e `ownerProfile`; status ativo derivado por projeto; label, toasts e loading dos diálogos.
