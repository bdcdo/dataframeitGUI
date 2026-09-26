-- Substituir duplicatas mantendo as respostas não troca o texto julgado
-- (migration 20260927160000_replace_documents_keeps_judged_text.sql).
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   bash scripts/run-sql-test.sh supabase/tests/replace_documents_keeps_judged_text.test.sql
-- Sucesso = nenhuma exceção e os NOTICE "OK ..." no final. Qualquer FALHOU aborta.
--
-- Roda inteiro dentro de BEGIN ... ROLLBACK, como owner: o objeto sob teste é a
-- guarda da RPC, não a RLS (coberta em atomic_replace_rpcs.test.sql).
--
-- Documentos:
--   D1 = com resposta, text_hash preenchido;
--   D2 = com resposta, text_hash NULL (documento anterior à coluna);
--   D3 = sem resposta nenhuma.

BEGIN;

INSERT INTO public.projects (id, name) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'proj texto julgado');

INSERT INTO public.documents (id, project_id, external_id, title, text, text_hash, metadata) VALUES
  ('a2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'D1', 'D1 titulo', 'texto d1', md5('texto d1'), '{"k":"v1"}'),
  ('a3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 'D2', 'D2 titulo', 'texto d2', NULL,            NULL),
  ('a4444444-4444-4444-4444-444444444444', 'a1111111-1111-1111-1111-111111111111', 'D3', 'D3 titulo', 'texto d3', md5('texto d3'), NULL);

-- A resposta humana corrente precisa de autor (responses_human_latest_has_actor_check).
INSERT INTO auth.users (id, email) VALUES
  ('a7777777-7777-7777-7777-777777777777', 'texto-julgado-respondent@example.test');
INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('texto-julgado-clerk', 'a7777777-7777-7777-7777-777777777777', 1);

INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('a5555555-5555-5555-5555-555555555551', 'a1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'a7777777-7777-7777-7777-777777777777', 'humano', '{"campo":"x"}'),
  ('a5555555-5555-5555-5555-555555555552', 'a1111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333', 'a7777777-7777-7777-7777-777777777777', 'humano', '{"campo":"y"}');

-- ----- (1) manter respostas + texto diferente: recusa, e a chamada inteira é desfeita -----
-- O lote leva também D3 (sem resposta, texto diferente) e um documento novo:
-- nenhum dos dois pode ficar gravado.
DO $$
DECLARE v_text text; v_title text; n_new int; n_resp int; v_d3 text;
BEGIN
  BEGIN
    PERFORM public.replace_and_add_documents(
      'a1111111-1111-1111-1111-111111111111'::uuid,
      ARRAY['a2222222-2222-2222-2222-222222222222'::uuid, 'a4444444-4444-4444-4444-444444444444'::uuid],
      false,
      '[{"id":"a2222222-2222-2222-2222-222222222222","text":"texto d1 NOVO","title":"D1 novo","external_id":"D1","text_hash":"h-qualquer","metadata":null},
        {"id":"a4444444-4444-4444-4444-444444444444","text":"texto d3 NOVO","title":"D3 novo","external_id":"D3","text_hash":"h-d3-novo","metadata":null}]'::jsonb,
      '[{"external_id":"NOVO-1","title":"novo","text":"texto novo","text_hash":"h-novo","metadata":null}]'::jsonb
    );
    RAISE EXCEPTION 'FALHOU (1): a RPC aceitou trocar o texto de documento com respostas mantendo as respostas';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%texto seria trocado%apagar as respostas%' THEN
      RAISE EXCEPTION 'FALHOU (1): mensagem inesperada: %', SQLERRM;
    END IF;
  END;

  SELECT text, title INTO v_text, v_title FROM public.documents WHERE id = 'a2222222-2222-2222-2222-222222222222';
  SELECT text INTO v_d3 FROM public.documents WHERE id = 'a4444444-4444-4444-4444-444444444444';
  SELECT count(*) INTO n_new FROM public.documents WHERE project_id = 'a1111111-1111-1111-1111-111111111111' AND external_id = 'NOVO-1';
  SELECT count(*) INTO n_resp FROM public.responses WHERE id = 'a5555555-5555-5555-5555-555555555551';
  IF v_text <> 'texto d1' OR v_title <> 'D1 titulo' THEN RAISE EXCEPTION 'FALHOU (1): D1 mudou (%, %)', v_text, v_title; END IF;
  IF v_d3 <> 'texto d3' THEN RAISE EXCEPTION 'FALHOU (1): D3 mudou no lote recusado (%)', v_d3; END IF;
  IF n_new <> 0 THEN RAISE EXCEPTION 'FALHOU (1): documento novo do lote recusado ficou gravado (n=%)', n_new; END IF;
  IF n_resp <> 1 THEN RAISE EXCEPTION 'FALHOU (1): resposta de D1 sumiu (n=%)', n_resp; END IF;
  RAISE NOTICE 'OK (1): texto diferente com respostas mantidas é recusado e o lote inteiro é desfeito';
END $$;

-- ----- (1b) hash enviado igual ao atual não abre a guarda -----
-- O chamador manda o text_hash antigo de D1 com texto diferente: a guarda olha o
-- texto, não o hash que chega do cliente.
DO $$
DECLARE v_text text;
BEGIN
  BEGIN
    PERFORM public.replace_and_add_documents(
      'a1111111-1111-1111-1111-111111111111'::uuid,
      ARRAY['a2222222-2222-2222-2222-222222222222'::uuid],
      false,
      jsonb_build_array(jsonb_build_object(
        'id','a2222222-2222-2222-2222-222222222222','text','texto d1 NOVO','title','D1 titulo',
        'external_id','D1','text_hash',md5('texto d1'),'metadata',NULL)),
      '[]'::jsonb
    );
    RAISE EXCEPTION 'FALHOU (1b): hash antigo com texto novo passou pela guarda';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  SELECT text INTO v_text FROM public.documents WHERE id = 'a2222222-2222-2222-2222-222222222222';
  IF v_text <> 'texto d1' THEN RAISE EXCEPTION 'FALHOU (1b): D1 mudou (%)', v_text; END IF;
  RAISE NOTICE 'OK (1b): hash enviado igual ao atual não abre a guarda';
END $$;

-- ----- (1c) p_delete_responses NULL conta como manter -----
DO $$
BEGIN
  BEGIN
    PERFORM public.replace_and_add_documents(
      'a1111111-1111-1111-1111-111111111111'::uuid,
      ARRAY['a2222222-2222-2222-2222-222222222222'::uuid],
      NULL,
      '[{"id":"a2222222-2222-2222-2222-222222222222","text":"texto d1 NOVO","title":"D1 titulo","external_id":"D1","text_hash":"h","metadata":null}]'::jsonb,
      '[]'::jsonb
    );
    RAISE EXCEPTION 'FALHOU (1c): p_delete_responses NULL pulou a guarda';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  RAISE NOTICE 'OK (1c): p_delete_responses NULL passa pela guarda';
END $$;

-- ----- (2) manter respostas + mesmo texto: título, metadata e external_id atualizam -----
DO $$
DECLARE v_text text; v_title text; v_ext text; v_meta jsonb; n_resp int;
BEGIN
  PERFORM public.replace_and_add_documents(
    'a1111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['a2222222-2222-2222-2222-222222222222'::uuid],
    false,
    jsonb_build_array(jsonb_build_object(
      'id','a2222222-2222-2222-2222-222222222222','text','texto d1','title','D1 titulo novo',
      'external_id','D1-NOVO','text_hash',md5('texto d1'),'metadata','{"k":"v2"}'::jsonb)),
    '[]'::jsonb
  );
  SELECT text, title, external_id, metadata INTO v_text, v_title, v_ext, v_meta
    FROM public.documents WHERE id = 'a2222222-2222-2222-2222-222222222222';
  SELECT count(*) INTO n_resp FROM public.responses WHERE id = 'a5555555-5555-5555-5555-555555555551';
  IF v_text <> 'texto d1' THEN RAISE EXCEPTION 'FALHOU (2): texto mudou (%)', v_text; END IF;
  IF v_title <> 'D1 titulo novo' OR v_ext <> 'D1-NOVO' OR v_meta <> '{"k":"v2"}'::jsonb THEN
    RAISE EXCEPTION 'FALHOU (2): título/external_id/metadata não atualizaram (%, %, %)', v_title, v_ext, v_meta;
  END IF;
  IF n_resp <> 1 THEN RAISE EXCEPTION 'FALHOU (2): resposta de D1 sumiu (n=%)', n_resp; END IF;
  RAISE NOTICE 'OK (2): mesmo texto com respostas mantidas atualiza título, metadata e external_id';
END $$;

-- ----- (4) documento com text_hash NULL -----
-- Texto diferente é recusado; mesmo texto é aceito e o hash passa a ser gravado.
DO $$
DECLARE v_text text; v_title text; v_hash text;
BEGIN
  BEGIN
    PERFORM public.replace_and_add_documents(
      'a1111111-1111-1111-1111-111111111111'::uuid,
      ARRAY['a3333333-3333-3333-3333-333333333333'::uuid],
      false,
      jsonb_build_array(jsonb_build_object(
        'id','a3333333-3333-3333-3333-333333333333','text','texto d2 NOVO','title','D2 titulo',
        'external_id','D2','text_hash',md5('texto d2 NOVO'),'metadata',NULL)),
      '[]'::jsonb
    );
    RAISE EXCEPTION 'FALHOU (4): texto trocado aceito em documento com text_hash NULL';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  SELECT text INTO v_text FROM public.documents WHERE id = 'a3333333-3333-3333-3333-333333333333';
  IF v_text <> 'texto d2' THEN RAISE EXCEPTION 'FALHOU (4): D2 mudou (%)', v_text; END IF;

  PERFORM public.replace_and_add_documents(
    'a1111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['a3333333-3333-3333-3333-333333333333'::uuid],
    false,
    jsonb_build_array(jsonb_build_object(
      'id','a3333333-3333-3333-3333-333333333333','text','texto d2','title','D2 titulo novo',
      'external_id','D2','text_hash',md5('texto d2'),'metadata',NULL)),
    '[]'::jsonb
  );
  SELECT title, text_hash INTO v_title, v_hash FROM public.documents WHERE id = 'a3333333-3333-3333-3333-333333333333';
  IF v_title <> 'D2 titulo novo' OR v_hash IS DISTINCT FROM md5('texto d2') THEN
    RAISE EXCEPTION 'FALHOU (4): mesmo texto em documento com text_hash NULL não atualizou (%, %)', v_title, v_hash;
  END IF;
  RAISE NOTICE 'OK (4): text_hash NULL não abre nem fecha a guarda indevidamente';
END $$;

-- ----- (5) documento sem resposta: texto troca mesmo mantendo respostas -----
DO $$
DECLARE v_text text;
BEGIN
  PERFORM public.replace_and_add_documents(
    'a1111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['a4444444-4444-4444-4444-444444444444'::uuid],
    false,
    '[{"id":"a4444444-4444-4444-4444-444444444444","text":"texto d3 NOVO","title":"D3 titulo","external_id":"D3","text_hash":"h-d3-novo","metadata":null}]'::jsonb,
    '[]'::jsonb
  );
  SELECT text INTO v_text FROM public.documents WHERE id = 'a4444444-4444-4444-4444-444444444444';
  IF v_text <> 'texto d3 NOVO' THEN RAISE EXCEPTION 'FALHOU (5): texto de documento sem resposta não trocou (%)', v_text; END IF;
  RAISE NOTICE 'OK (5): documento sem resposta troca de texto sem apagar nada';
END $$;

-- ----- (3) apagar respostas + texto diferente: aceito -----
DO $$
DECLARE v_text text; n_resp int;
BEGIN
  PERFORM public.replace_and_add_documents(
    'a1111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['a2222222-2222-2222-2222-222222222222'::uuid],
    true,
    '[{"id":"a2222222-2222-2222-2222-222222222222","text":"texto d1 NOVO","title":"D1 titulo","external_id":"D1","text_hash":"h-d1-novo","metadata":null}]'::jsonb,
    '[]'::jsonb
  );
  SELECT text INTO v_text FROM public.documents WHERE id = 'a2222222-2222-2222-2222-222222222222';
  SELECT count(*) INTO n_resp FROM public.responses WHERE document_id = 'a2222222-2222-2222-2222-222222222222';
  IF v_text <> 'texto d1 NOVO' THEN RAISE EXCEPTION 'FALHOU (3): texto não trocou com apagar respostas (%)', v_text; END IF;
  IF n_resp <> 0 THEN RAISE EXCEPTION 'FALHOU (3): respostas de D1 não foram apagadas (n=%)', n_resp; END IF;
  RAISE NOTICE 'OK (3): apagar respostas permite trocar o texto';
END $$;

ROLLBACK;
