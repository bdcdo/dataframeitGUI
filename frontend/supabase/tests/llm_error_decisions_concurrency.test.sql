-- As fixtures são confirmadas entre conexões; executar com o runner Docker local.

-- Como nas outras suítes com dblink: num banco recém-resetado a extensão só
-- existe se alguma suíte anterior a criou, e a ordem do runner não é contrato.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

BEGIN;
INSERT INTO auth.users (id, email) VALUES
  ('b9a00000-0000-0000-0000-000000000001', 'concurrent-owner@example.test'),
  ('b9a00000-0000-0000-0000-000000000002', 'concurrent-human@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'b9a00000-%';
INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields) VALUES
  ('b9b00000-0000-0000-0000-000000000001', 'Concurrent decisions test', 'b9a00000-0000-0000-0000-000000000001', 'compare_llm', '[{"id":"b9f00000-0000-4000-8000-000000000001","name":"q","type":"text"}]');
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('b9c00000-0000-0000-0000-000000000001', 'b9b00000-0000-0000-0000-000000000001', 'Documento', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('b9d00000-0000-0000-0000-000000000001', 'b9b00000-0000-0000-0000-000000000001', 'b9c00000-0000-0000-0000-000000000001', NULL, 'llm', '{"q":"LLM"}'),
  ('b9d00000-0000-0000-0000-000000000002', 'b9b00000-0000-0000-0000-000000000001', 'b9c00000-0000-0000-0000-000000000001', 'b9a00000-0000-0000-0000-000000000002', 'humano', '{"q":"Humano"}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('b9e00000-0000-0000-0000-000000000001', 'b9b00000-0000-0000-0000-000000000001', 'b9c00000-0000-0000-0000-000000000001', 'q', 'b9a00000-0000-0000-0000-000000000001', 'Humano', 'b9d00000-0000-0000-0000-000000000002');
COMMIT;

SELECT set_config('request.jwt.claims', '{"sub":"b9a00000-0000-0000-0000-000000000001","supabase_uid":"b9a00000-0000-0000-0000-000000000001"}', false);
DO $$
DECLARE
  conn TEXT := format('host=%s port=%s dbname=%s user=postgres password=postgres', inet_server_addr(), inet_server_port(), current_database());
  init TEXT := 'BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claims" = ''{"sub":"b9a00000-0000-0000-0000-000000000001","supabase_uid":"b9a00000-0000-0000-0000-000000000001"}'';';
  context JSONB;
  query TEXT;
  pid2 INTEGER;
  deadline TIMESTAMPTZ;
  saved JSONB;
BEGIN
  PERFORM extensions.dblink_connect('decision_one', conn);
  PERFORM extensions.dblink_connect('decision_two', conn);
  PERFORM extensions.dblink_exec('decision_one', init);
  PERFORM extensions.dblink_exec('decision_two', init);
  SELECT pid INTO pid2 FROM extensions.dblink('decision_two', 'SELECT pg_backend_pid()') AS t(pid INTEGER);
  context := public.llm_error_context('b9b00000-0000-0000-0000-000000000001', 'b9c00000-0000-0000-0000-000000000001', 'q',
    'b9d00000-0000-0000-0000-000000000001', 'b9d00000-0000-0000-0000-000000000002', 'comparacao', 'b9e00000-0000-0000-0000-000000000001');
  IF context IS NULL THEN RAISE EXCEPTION 'FALHOU: contexto da fixture ausente'; END IF;
  query := format('SELECT public.set_error_resolution(''b9b00000-0000-0000-0000-000000000001'', ''b9c00000-0000-0000-0000-000000000001'', ''q'', %%L, %L::JSONB, NULL, NULL)', context::TEXT);
  SELECT value INTO saved FROM extensions.dblink('decision_one', format(query, 'llm_correct')) AS t(value JSONB);
  PERFORM extensions.dblink_send_query('decision_two', format(query, 'researchers_correct'));
  deadline := clock_timestamp() + interval '5 seconds';
  LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = pid2 AND wait_event = 'advisory');
    IF clock_timestamp() > deadline THEN RAISE EXCEPTION 'FALHOU: segunda confirmação não aguardou o lock'; END IF;
    PERFORM pg_sleep(0.01);
    PERFORM pg_stat_clear_snapshot();
  END LOOP;
  PERFORM extensions.dblink_exec('decision_one', 'COMMIT');
  PERFORM * FROM extensions.dblink_get_result('decision_two', false) AS t(value JSONB);
  IF extensions.dblink_error_message('decision_two') NOT LIKE '%A decisão mudou%' THEN
    RAISE EXCEPTION 'FALHOU: segunda confirmação não recebeu conflito';
  END IF;
  PERFORM * FROM extensions.dblink_get_result('decision_two', false) AS t(value JSONB);
  PERFORM extensions.dblink_exec('decision_two', 'ROLLBACK');
  PERFORM extensions.dblink_disconnect('decision_one');
  PERFORM extensions.dblink_disconnect('decision_two');
  IF NOT EXISTS (SELECT 1 FROM public.error_resolutions WHERE id = (saved->>'id')::UUID AND decision = 'llm_correct') THEN
    RAISE EXCEPTION 'FALHOU: segunda confirmação sobrescreveu a primeira';
  END IF;
END $$;

BEGIN;
DELETE FROM public.projects WHERE id = 'b9b00000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id IN ('b9a00000-0000-0000-0000-000000000001', 'b9a00000-0000-0000-0000-000000000002');
COMMIT;
