-- Autoidentidade e liberação de pendências na remoção de membros (issue #177).
--
-- Duas lacunas distintas na `main`:
--
--   1. `enforce_project_members_column_guard` impede que alguém mude o PRÓPRIO
--      papel, mas nada impede que se REMOVA a própria membership. A policy
--      "Coordinators manage members" é FOR ALL por projeto, não por linha, então
--      um coordenador pode se autoexcluir por DELETE direto no PostgREST —
--      possivelmente deixando o projeto sem coordenador.
--
--   2. `remove_project_member` limpa as pendências do membro, mas essa limpeza
--      vive na RPC. Qualquer outro caminho de DELETE (PostgREST direto, script
--      administrativo) deixa assignments pendentes apontando para quem não é
--      mais membro.
--
-- Escolha de mecanismo para (1): policy RESTRICTIVE, não trigger. É a primeira
-- restritiva do repositório, e a razão é o CASCADE: `project_members.project_id`
-- referencia `projects` com ON DELETE CASCADE, então apagar um projeto remove a
-- membership do próprio dono. RLS não se aplica a DELETE disparado por cascade
-- referencial, de modo que a policy protege o caminho do usuário sem bloquear a
-- exclusão do projeto. Um trigger que levantasse exceção quebraria justamente
-- esse caso — a armadilha que a 20260724100000 teve de desfazer para os
-- triggers de arquivamento.

-- ---------------------------------------------------------------------------
-- Saneamento: pendências que já perderam a membership pelos caminhos antigos.
-- Reparo medido, não abort: a contagem vai para o log do deploy.
-- Aliases órfãos não entram aqui — a FK composta criada em 20260716155000
-- (member_email_links_project_member_fkey, ON DELETE CASCADE) já os elimina.
--
-- Não conflita com a nota da 20260716160300 ("pendência real sem membro atual
-- não é órfã e fica intacta"): lá a regra governa o RECONCILIADOR, que não faz
-- coleta de lixo por conta própria. O caminho de REMOÇÃO sempre limpou as
-- pendências do removido — a RPC anterior já fazia isso, sem filtro de tipo. O
-- que este DELETE alcança é o resíduo dos caminhos que não passaram pela RPC.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_orphan_pending integer;
BEGIN
  DELETE FROM public.assignments AS a
  WHERE a.status = 'pendente'
    AND a.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.project_members AS pm
      WHERE pm.project_id = a.project_id
        AND pm.user_id = a.user_id
    )
    -- Conta-alias legada exerce a membership por VÍNCULO, não por linha
    -- própria em project_members: o NOT EXISTS acima não a enxerga. Antes da
    -- 20260716155000 as filas resolviam a identidade canônica enquanto outras
    -- escritas gravavam o uid CRU da sessão — a mesma assimetria que aquela
    -- migration teve de reescrever em response_equivalences,
    -- verdict_acknowledgments e researcher_field_orders. Uma pendência assim é
    -- trabalho vivo de quem continua no projeto, não resíduo.
    AND NOT EXISTS (
      SELECT 1
      FROM public.member_email_links AS mel
      WHERE mel.project_id = a.project_id
        AND mel.linked_user_id = a.user_id
    );
  GET DIAGNOSTICS v_orphan_pending = ROW_COUNT;

  RAISE NOTICE
    'Saneamento #177: % assignment(s) pendente(s) sem membership devolvido(s) ao pool.',
    v_orphan_pending;
END;
$$;

-- ---------------------------------------------------------------------------
-- (2) A liberação passa a viver na membership, e não só na RPC.
--
-- Mesmo movimento que a 20260716155000 fez com os aliases: declarou o ciclo de
-- vida na FK e removeu o DELETE explícito da RPC, para não ter duas fontes da
-- mesma regra. Aqui o trigger assume as pendências e o CTE correspondente sai
-- da RPC (mais abaixo).
--
-- Histórico é preservado por construção: só `status = 'pendente'` é apagado.
-- Trabalho iniciado ou concluído continua sendo o registro do que aconteceu.
--
-- SECURITY DEFINER, e não INVOKER como a RPC de onde a limpeza saiu: a
-- liberação precisa acontecer para TODO caminho de DELETE, inclusive um cujo
-- chamador não tenha RLS de DELETE em `assignments`. Sob INVOKER esse caso
-- produziria remoção silenciosamente PARCIAL — a membership sai, as pendências
-- ficam —, que é exatamente o estado que este trigger existe para tornar
-- irrepresentável. O escopo compensa a elevação: só (project_id, user_id) da
-- linha removida, e só `pendente`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_pending_assignments_on_member_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Quando o DELETE vem do cascade de `projects`, a âncora já saiu e os
  -- assignments serão cascateados pela mesma remoção: varrer aqui seria
  -- trabalho puro. Mesmo cuidado da 20260724100000.
  IF NOT EXISTS (
    SELECT 1 FROM public.projects WHERE id = OLD.project_id
  ) THEN
    RETURN OLD;
  END IF;

  DELETE FROM public.assignments AS a
  WHERE a.project_id = OLD.project_id
    AND a.user_id = OLD.user_id
    AND a.status = 'pendente';

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.release_pending_assignments_on_member_delete()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS release_pending_assignments_on_member_delete_trigger
  ON public.project_members;
CREATE TRIGGER release_pending_assignments_on_member_delete_trigger
  BEFORE DELETE ON public.project_members
  FOR EACH ROW
  EXECUTE FUNCTION public.release_pending_assignments_on_member_delete();

-- ---------------------------------------------------------------------------
-- (1) Autoidentidade: nem por DELETE direto.
--
-- RESTRICTIVE porque a proibição precisa valer junto de TODA policy permissiva,
-- atual ou futura, de administração de membros — uma permissiva nova não pode
-- reabrir o buraco por engano. Sem cláusula TO, pelo mesmo motivo: restritiva
-- com TO explícito só restringe os roles listados, e um role novo entraria
-- livre. `service_role` segue passando por BYPASSRLS, como em toda a RLS daqui.
--
-- Master é isento, como em enforce_project_members_column_guard
-- (20260715095741), que já o isenta para a alteração do próprio papel. O alvo
-- desta regra é o coordenador/criador que se autoexcluiria e possivelmente
-- deixaria o projeto sem coordenador; master é o break-glass da plataforma e
-- não perde a própria linha de membership como efeito colateral disso.
--
-- NOTA DE FORMA (não "corrigir" para a tupla): o predicado é um NOT EXISTS
-- CORRELACIONADO de propósito, e não a forma `(project_id, user_id) NOT IN
-- (SELECT ...)` que a 20260716155000:1362 registra como preferida. O motivo é
-- que `project_members.user_id` é NULLABLE (001_initial_schema.sql): para uma
-- linha de user_id nulo, a tupla-NOT IN avalia NULL — não true —, e a
-- restritiva tornaria essa linha INDELETÁVEL por qualquer caminho de usuário.
-- A regressão de ~9× que aquela migration mediu era com o helper
-- PARAMETRIZADO (auth_user_member_identity_ids(project_id)), reexecutado por
-- linha; aqui o helper não recebe argumento, então o function scan mantém o
-- tuplestore entre os rescans do SubPlan. A tabela também é minúscula.
--
-- O helper cobre também a conta-alias: quem entra por e-mail vinculado exerce a
-- identidade canônica e igualmente não pode removê-la.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Members cannot remove their own identity"
  ON public.project_members;
CREATE POLICY "Members cannot remove their own identity"
  ON public.project_members
  AS RESTRICTIVE
  FOR DELETE
  USING (
    (SELECT public.is_master())
    OR NOT EXISTS (
      SELECT 1
      FROM public.auth_user_project_memberships() AS membership
      WHERE membership.project_id = project_members.project_id
        AND membership.user_id = project_members.user_id
    )
  );

-- ---------------------------------------------------------------------------
-- A RPC ganha o guard explícito e perde a limpeza de pendências (agora no
-- trigger acima).
--
-- Guard e policy cobrem a MESMA invariante, de propósito, e cada um vale numa
-- situação diferente:
--   - a policy é a garantia real, e a única que alcança o DELETE direto no
--     PostgREST;
--   - o guard existe pela mensagem: barrado só pela policy, o DELETE remove
--     zero linhas e a action traduz isso como "Membro não encontrado ou sem
--     permissão", indistinguível de um id inexistente. O RAISE devolve 42501 e
--     diz ao coordenador o que de fato aconteceu.
-- Remover o guard não abre falha de segurança; degrada a mensagem. Remover a
-- policy abre.
--
-- O braço de master repete o da policy porque os dois lados decidem a MESMA
-- coisa: sem ele, master seria liberado pela policy e levaria 42501 da RPC —
-- barrado justamente pelo mecanismo que existe só para explicar o bloqueio.
--
-- CREATE OR REPLACE preservando assinatura e tipo de retorno: um DROP+CREATE
-- descartaria o `GRANT EXECUTE ... TO authenticated` emitido na
-- 20260715160000 e a RPC passaria a falhar em produção para todo mundo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_project_member(
  p_member_id uuid
) RETURNS TABLE(project_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_user_id uuid;
BEGIN
  -- FOR UPDATE trava a linha alvo: sem isso, a checagem de autoidentidade e o
  -- DELETE poderiam observar estados diferentes se um alias fosse vinculado no
  -- meio do caminho. A RLS continua valendo (SECURITY INVOKER), então este
  -- SELECT só enxerga o que o chamador poderia enxergar.
  SELECT pm.project_id, pm.user_id
  INTO v_project_id, v_user_id
  FROM public.project_members AS pm
  WHERE pm.id = p_member_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT (SELECT public.is_master()) AND EXISTS (
    SELECT 1
    FROM public.auth_user_project_memberships() AS membership
    WHERE membership.project_id = v_project_id
      AND membership.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Você não pode remover sua própria associação ao projeto.'
      USING ERRCODE = '42501';
  END IF;

  -- As pendências saem pelo trigger BEFORE DELETE e os aliases pela FK
  -- composta. Repetir qualquer um dos dois aqui criaria uma segunda fonte da
  -- mesma regra.
  DELETE FROM public.project_members AS pm
  WHERE pm.id = p_member_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_project_id;
END;
$$;
