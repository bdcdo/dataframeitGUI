# Quickstart — Caminho de autenticação rápido e recuperável

## Pré-requisitos

- Worktree na branch `003-auth-render-path`.
- Variáveis de ambiente do frontend configuradas em `frontend/.env.local`.
- Conta Clerk de teste para cada papel: coordenador, pesquisador direto, pesquisador por e-mail alternativo, master user e usuário autenticado sem projeto.
- Projeto de teste com ao menos uma página protegida representativa e filas de trabalho.

## Validação automatizada esperada

1. Rodar os testes frontend relevantes.

   ```bash
   cd frontend
   npm run typecheck
   npm test -- --run src/lib/__tests__/auth-request-dedup.test.ts src/lib/__tests__/auth-no-remote-lookup.test.ts src/lib/__tests__/auth-fail-closed.test.ts src/lib/__tests__/auth-effective-member.test.ts src/lib/__tests__/clerk-primary-email.test.ts src/lib/__tests__/clerk-sync.test.ts src/lib/__tests__/project-access.test.ts src/lib/__tests__/viewas-no-write.test.ts src/lib/__tests__/no-legacy-token-path.test.ts src/actions/__tests__/complete-access.test.ts src/app/api/webhooks/clerk/route.test.ts src/app/auth/__tests__/access-completion-reason.test.tsx src/app/auth/__tests__/access-completion-a11y.test.tsx
   ```

2. Quando a implementação tocar helpers puros de auth/autorização, adicionar testes Vitest que cubram:

   - resolução de identidade uma vez por request;
   - sessão válida com vínculo preparado;
   - sessão válida com link pendente;
   - link divergente;
   - usuário sem projeto;
   - falha técnica de sincronização;
   - retry idempotente de conclusão de acesso;
   - `viewAs` sem concessão de escrita como identidade visualizada.

3. Validar as migrations e regressões no banco local. A aplicação ao ambiente remoto ocorre somente pelo procedimento manual separado do projeto; este quickstart não publica schema. A integridade da autoria LLM já vem da `main` em `20260716154500_responses_llm_actor_integrity.sql`. No rollout aprovado, o bloco pendente deste PR — `20260716160000_canonical_project_identity_rls.sql`, `20260716160100_prevent_self_arbitration.sql`, `20260716160200_sync_auto_review_assignment_status.sql` e `20260716160300_auto_review_assignment_integrity.sql` — precisa ser aplicado, nessa ordem, antes do frontend. O `db push --dry-run` deve listar exatamente essas quatro migrations, sem `--include-all`; o código novo exige os markers e RPCs novos e falha fechado diante do schema anterior.

   ```bash
   cd frontend
   npx supabase db reset
   for file in supabase/tests/*.test.sql; do docker exec -i supabase_db_frontend psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$file" || exit 1; done
   ```

4. Se backend FastAPI não for alterado, `pytest` não é obrigatório para esta feature. Se algum serviço backend for tocado, rodar:

   ```bash
   cd backend && uv run pytest
   ```

## Validação manual — caminho feliz

1. Entrar com usuário autenticado que já possui vínculo interno ativo.
2. Abrir o dashboard sem cache de navegador.
3. Abrir uma página protegida de projeto.
4. Confirmar que a página mostra conteúdo autorizado sem tela intermediária de autenticação.
5. Confirmar que a página fica utilizável em até 300 ms p95 na medição definida para a feature, com 150–250 ms como alvo.
6. Confirmar, por log/teste/instrumentação, que a identidade autenticada foi resolvida uma vez na request representativa.

## Validação manual — conclusão de acesso

1. Entrar com conta Clerk válida sem vínculo interno confirmado.
2. Acessar uma página protegida.
3. Confirmar redirecionamento para conclusão/reparo de acesso.
4. Confirmar que a mensagem explica, em pt-BR, que a sessão existe, mas o acesso ainda precisa ser concluído.
5. Acionar retry.
6. Confirmar que retry bem-sucedido leva ao dashboard ou à URL segura pretendida.
7. Repetir retry e confirmar que não há duplicação de `profiles`, `clerk_user_mapping` nem memberships.

## Validação manual — autoridade Clerk e revogação

1. Entrar com mapping preparado, mas remover o ID primário ou deixar o endereço primário sem verificação → a página protegida falha fechada e a conclusão não escolhe outro endereço da conta.
2. Numa conta com alias resolvido, remover o endereço verificado e disparar `user.updated` → o alias perde acesso depois da reconciliação integral da lista atual.
3. Excluir a conta e entregar `user.deleted` → o marker passa a fechado, aliases são removidos e repetir o evento não recria estado.
4. Simular geração 200 depois da 100 e tentar concluir a 100 → apenas a geração 200 altera profile, aliases e marker.
5. Confirmar que um JWT antigo com `supabase_uid` deixa de resolver em `clerk_uid()` assim que o begin da reconciliação ou revogação grava marker `0`.

## Validação manual — ausência de projeto

1. Entrar com usuário autenticado e vínculo ativo, mas sem membership em projetos.
2. Abrir dashboard.
3. Confirmar que a interface informa ausência de projetos de forma clara.
4. Confirmar que o caso não é tratado como erro técnico nem como signed out.

## Validação manual — papéis e permissões

1. Coordenador: abrir projeto, abas de configuração, análise e filas; confirmar ações de coordenação esperadas.
2. Pesquisador direto: abrir filas e formulários; confirmar que apenas documentos e ações permitidos aparecem.
3. Pesquisador por e-mail alternativo: confirmar que filas pessoais resolvem para o membro canônico.
4. Master user sem `viewAs`: confirmar visibilidade master esperada.
5. Master user com `viewAs`: confirmar que leitura, navegação e escopo visual seguem a identidade visualizada, mas escritas continuam proibidas ou atribuídas ao ator real quando ele já tiver permissão própria.
6. Usuário sem acesso ao projeto: abrir URL direta e confirmar negação fechada sem dados do projeto.

## Validação de regressão

- Procurar no diff por uso ordinário de service key em páginas protegidas; deve haver justificativa explícita para qualquer uso pontual fora do caminho comum.
- Confirmar que o caminho padrão de leitura de dados protegidos usa Clerk + JWT Supabase + RLS.
- Confirmar que não foi reintroduzido token customizado legado como caminho ordinário.
- Confirmar que layouts/pages protegidos não chamam full remote user lookup repetidamente para cada leitura independente.
- Confirmar que falha de vínculo não executa reparo silencioso no render protegido.
- Confirmar que `profileByEmail` administrativo não substitui `ownerProfile` verificado e que `resolveProjectMemberActor` é a única porta das mutations pessoais.

## Critério de pronto

A feature só pode avançar para `/speckit-tasks` quando `plan.md`, `research.md`, `data-model.md`, `contracts/` e este quickstart estiverem coerentes entre si, sem `NEEDS CLARIFICATION`, e com Constitution Check aprovado antes e depois do design.
