-- Verificação de atomicidade das RPCs transacionais (issues #181 e #284).
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/atomic_replace_rpcs.test.sql
-- Sucesso = nenhuma exceção e os NOTICE "OK ..." no final. Qualquer FALHOU aborta.
--
-- Roda inteiro dentro de BEGIN ... ROLLBACK: não altera dados locais. Prova a
-- ATOMICIDADE (a chamada à função é um statement atômico — erro no INSERT
-- reverte os DELETEs/UPDATEs anteriores da mesma chamada). Executa como owner,
-- então NÃO testa RLS (isso fica nas policies + rls-guard.test.ts); o objeto
-- aqui é a transação. Sem dependência de profiles/auth.users: os FKs
-- created_by / respondent_id / reviewer_id / user_id são todos nuláveis.

BEGIN;

-- ----- Fixtures -----
INSERT INTO public.projects (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'proj atomic test');

-- D1 = doc alvo do "replace"; D2 = doc ativo cujo external_id 'EXISTING' será
-- colidido pelo INSERT do caminho de falha.
INSERT INTO public.documents (id, project_id, external_id, title, text, text_hash) VALUES
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', NULL,       'D1 alvo',  'texto d1', 'h-d1'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'EXISTING', 'D2 ativo', 'texto d2', 'h-d2');

INSERT INTO public.responses (id, project_id, document_id, respondent_type, answers) VALUES
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'humano', '{"campo":"x"}');

INSERT INTO public.reviews (id, project_id, document_id, field_name, verdict) VALUES
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'campo', 'concordo');

INSERT INTO public.assignments (id, project_id, document_id, status, type) VALUES
  ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'concluido', 'codificacao');

-- ----- #284: falha no INSERT reverte os deletes/reset da mesma chamada -----
DO $$
BEGIN
  PERFORM public.replace_and_add_documents(
    '11111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['22222222-2222-2222-2222-222222222222'::uuid],
    true,            -- delete responses/reviews + reset assignments
    '[]'::jsonb,     -- sem dup updates
    -- novo doc com external_id 'EXISTING' (já ativo) -> viola o índice parcial
    '[{"external_id":"EXISTING","title":"colide","text":"y","text_hash":"h-new","metadata":null}]'::jsonb
  );
  RAISE EXCEPTION 'TESTE FALHOU: a RPC deveria ter abortado com unique_violation';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'OK: RPC abortou com unique_violation (esperado)';
END $$;

DO $$
DECLARE n_resp int; n_rev int; a_status text;
BEGIN
  SELECT count(*) INTO n_resp   FROM public.responses   WHERE id = '44444444-4444-4444-4444-444444444444';
  SELECT count(*) INTO n_rev    FROM public.reviews     WHERE id = '55555555-5555-5555-5555-555555555555';
  SELECT status   INTO a_status FROM public.assignments WHERE id = '66666666-6666-6666-6666-666666666666';
  IF n_resp <> 1   THEN RAISE EXCEPTION 'FALHOU #284: response apagada sem rollback (n=%)', n_resp; END IF;
  IF n_rev  <> 1   THEN RAISE EXCEPTION 'FALHOU #284: review apagada sem rollback (n=%)', n_rev; END IF;
  IF a_status <> 'concluido' THEN RAISE EXCEPTION 'FALHOU #284: assignment resetado sem rollback (status=%)', a_status; END IF;
  RAISE NOTICE 'OK #284: responses/reviews/assignments preservados apos falha (rollback atomico)';
END $$;

-- ----- #284: caminho feliz aplica deletes + insere o novo doc -----
DO $$
DECLARE n_new int; n_resp int;
BEGIN
  PERFORM public.replace_and_add_documents(
    '11111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['22222222-2222-2222-2222-222222222222'::uuid],
    true, '[]'::jsonb,
    '[{"external_id":"NEW-OK","title":"novo","text":"z","text_hash":"h-ok","metadata":null}]'::jsonb
  );
  SELECT count(*) INTO n_new  FROM public.documents WHERE project_id = '11111111-1111-1111-1111-111111111111' AND external_id = 'NEW-OK';
  SELECT count(*) INTO n_resp FROM public.responses WHERE id = '44444444-4444-4444-4444-444444444444';
  IF n_new  <> 1 THEN RAISE EXCEPTION 'FALHOU: novo doc nao inserido no caminho feliz (n=%)', n_new; END IF;
  IF n_resp <> 0 THEN RAISE EXCEPTION 'FALHOU: deleteResponses nao apagou a response no caminho feliz (n=%)', n_resp; END IF;
  RAISE NOTICE 'OK #284: caminho feliz inseriu o novo doc e aplicou os deletes';
END $$;

-- ----- #181: apply_lottery_assignments(replace) descarta pendentes do tipo + insere -----
DO $$
DECLARE n_pend int;
BEGIN
  -- Pendente antiga (em D2) que deve ser descartada pelo modo replace.
  INSERT INTO public.assignments (project_id, document_id, status, type)
    VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'pendente', 'codificacao');
  PERFORM public.apply_lottery_assignments(
    '11111111-1111-1111-1111-111111111111'::uuid, 'codificacao', NULL,
    '[{"document_id":"22222222-2222-2222-2222-222222222222","user_id":null}]'::jsonb,
    true
  );
  SELECT count(*) INTO n_pend FROM public.assignments
    WHERE project_id = '11111111-1111-1111-1111-111111111111' AND type = 'codificacao' AND status = 'pendente';
  IF n_pend <> 1 THEN RAISE EXCEPTION 'FALHOU #181: esperava 1 pendente (a nova), achei %', n_pend; END IF;
  RAISE NOTICE 'OK #181: replace descartou a pendente antiga e inseriu a nova atomicamente';
END $$;

ROLLBACK;
