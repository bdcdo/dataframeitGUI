-- Contrato: a resolução de uma anotação vale enquanto a anotação não muda (#760).
--
-- `note_resolutions` é presa ao `response_id`, e salvar a codificação dentro
-- da rodada é um UPDATE na mesma linha de `responses`. O gatilho
-- `archive_review_dependencies_on_response_change` apaga a resolução quando
-- `justifications->'_notes'` muda. Casos:
--   (1) anotação reescrita pelo próprio pesquisador, com o payload do save,
--       perde a resolução;
--   (2) resposta editada sem mexer em `_notes` mantém a resolução;
--   (3) anotação apagada perde a resolução, tanto com `justifications` NULL
--       (o que o save grava sem anotação) quanto com a chave ausente;
--   (4) outra resposta do mesmo documento não é afetada;
--   (5) a rebaixa de `is_latest` sem mudar a anotação mantém a resolução.
--
-- Roda numa transação e não deixa fixture no banco local.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('c7600000-0000-0000-0000-000000000001', 'nota-owner@example.test'),
  ('c7600000-0000-0000-0000-000000000002', 'nota-coder@example.test'),
  ('c7600000-0000-0000-0000-000000000003', 'nota-coder2@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'c7600000-%';
INSERT INTO public.projects (id, name, created_by, pydantic_fields) VALUES
  ('c7610000-0000-0000-0000-000000000001', 'resolução segue a anotação', 'c7600000-0000-0000-0000-000000000001',
   '[{"id":"c76f0000-0000-4000-8000-000000000001","name":"q","type":"text","target":"all","description":"P","hash":"q00000000001"}]');
INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('c7610000-0000-0000-0000-000000000001', 'c7600000-0000-0000-0000-000000000002', 'pesquisador'),
  ('c7610000-0000-0000-0000-000000000001', 'c7600000-0000-0000-0000-000000000003', 'pesquisador');

INSERT INTO public.documents (id, project_id, title, text)
SELECT ('c7620000-0000-0000-0000-00000000000' || n)::UUID, 'c7610000-0000-0000-0000-000000000001', 'Doc ' || n, 'Texto'
FROM generate_series(1, 5) AS n;

-- Pesquisador …02 responde os documentos 1 a 5 (resposta …0n); no documento 1
-- o pesquisador …03 também responde (resposta …11). Toda resposta traz
-- anotação, e toda anotação está resolvida.
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, justifications, answer_field_hashes, is_partial)
SELECT ('c7630000-0000-0000-0000-00000000000' || n)::UUID, 'c7610000-0000-0000-0000-000000000001',
  ('c7620000-0000-0000-0000-00000000000' || n)::UUID, 'c7600000-0000-0000-0000-000000000002', 'humano',
  '{"q":"sim"}', jsonb_build_object('_notes', 'nota original ' || n), '{"q":"q00000000001"}', false
FROM generate_series(1, 5) AS n;
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers, justifications, answer_field_hashes, is_partial) VALUES
  ('c7630000-0000-0000-0000-000000000011', 'c7610000-0000-0000-0000-000000000001',
   'c7620000-0000-0000-0000-000000000001', 'c7600000-0000-0000-0000-000000000003', 'humano',
   '{"q":"não"}', '{"_notes":"nota do colega"}', '{"q":"q00000000001"}', false);

INSERT INTO public.note_resolutions (project_id, response_id, resolved_by, note)
SELECT 'c7610000-0000-0000-0000-000000000001', response.id, 'c7600000-0000-0000-0000-000000000001', 'vista'
FROM public.responses AS response
WHERE response.project_id = 'c7610000-0000-0000-0000-000000000001';

CREATE FUNCTION pg_temp.resolved(p_response_id UUID) RETURNS BOOLEAN
LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM public.note_resolutions WHERE response_id = p_response_id);
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.note_resolutions
      WHERE project_id = 'c7610000-0000-0000-0000-000000000001') <> 6 THEN
    RAISE EXCEPTION 'FALHOU: fixture sem as seis resoluções';
  END IF;
  RAISE NOTICE 'OK: fixture';
END $$;

-- (1) e (4): o pesquisador reescreve a anotação do documento 1 pelo caminho
-- do save (UPDATE pela chave lógica, com o mesmo `answers`), como
-- `authenticated`. Ele não pode apagar `note_resolutions` pela RLS; quem apaga
-- é o gatilho.
SELECT set_config('request.jwt.claims',
  '{"sub":"c7600000-0000-0000-0000-000000000002","supabase_uid":"c7600000-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;
UPDATE public.responses
SET answers = '{"q":"sim"}',
    justifications = '{"_notes":"nota reescrita 1"}',
    answer_field_hashes = '{"q":"q00000000001"}',
    is_partial = false,
    updated_at = pg_catalog.now()
WHERE project_id = 'c7610000-0000-0000-0000-000000000001'
  AND document_id = 'c7620000-0000-0000-0000-000000000001'
  AND respondent_id = 'c7600000-0000-0000-0000-000000000002'
  AND respondent_type = 'humano'
  AND is_latest;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT justifications ->> '_notes' FROM public.responses
      WHERE id = 'c7630000-0000-0000-0000-000000000001') <> 'nota reescrita 1' THEN
    RAISE EXCEPTION 'FALHOU: o UPDATE do pesquisador não gravou a anotação nova';
  END IF;
  IF pg_temp.resolved('c7630000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU (1): anotação reescrita continuou resolvida';
  END IF;
  RAISE NOTICE 'OK (1): anotação reescrita perde a resolução';
  IF NOT pg_temp.resolved('c7630000-0000-0000-0000-000000000011') THEN
    RAISE EXCEPTION 'FALHOU (4): a resolução da outra resposta do documento caiu';
  END IF;
  RAISE NOTICE 'OK (4): outra resposta do mesmo documento mantém a resolução';
END $$;

-- (2) Documento 2: a resposta muda e a anotação é regravada igual.
UPDATE public.responses
SET answers = '{"q":"talvez"}',
    justifications = '{"_notes":"nota original 2"}',
    updated_at = pg_catalog.now()
WHERE id = 'c7630000-0000-0000-0000-000000000002';

DO $$
BEGIN
  IF NOT pg_temp.resolved('c7630000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FALHOU (2): resposta editada sem mudar a anotação perdeu a resolução';
  END IF;
  RAISE NOTICE 'OK (2): resposta editada sem mudar a anotação mantém a resolução';
END $$;

-- (3) Documento 3: o save sem anotação grava `justifications` NULL.
-- Documento 4: a chave `_notes` some e `justifications` segue objeto.
UPDATE public.responses SET justifications = NULL
WHERE id = 'c7630000-0000-0000-0000-000000000003';
UPDATE public.responses SET justifications = '{}'
WHERE id = 'c7630000-0000-0000-0000-000000000004';

DO $$
BEGIN
  IF pg_temp.resolved('c7630000-0000-0000-0000-000000000003') THEN
    RAISE EXCEPTION 'FALHOU (3): anotação apagada (justifications NULL) continuou resolvida';
  END IF;
  IF pg_temp.resolved('c7630000-0000-0000-0000-000000000004') THEN
    RAISE EXCEPTION 'FALHOU (3): anotação apagada (chave ausente) continuou resolvida';
  END IF;
  RAISE NOTICE 'OK (3): anotação apagada perde a resolução';
END $$;

-- (5) Documento 5: a resposta deixa de ser a corrente com a mesma anotação,
-- como na abertura de rodada nova.
UPDATE public.responses SET is_latest = false
WHERE id = 'c7630000-0000-0000-0000-000000000005';

DO $$
BEGIN
  IF (SELECT is_latest FROM public.responses WHERE id = 'c7630000-0000-0000-0000-000000000005') THEN
    RAISE EXCEPTION 'FALHOU: a rebaixa de is_latest não foi gravada';
  END IF;
  IF NOT pg_temp.resolved('c7630000-0000-0000-0000-000000000005') THEN
    RAISE EXCEPTION 'FALHOU (5): rebaixa de is_latest sem mudar a anotação derrubou a resolução';
  END IF;
  RAISE NOTICE 'OK (5): rebaixa de is_latest mantém a resolução';
END $$;

ROLLBACK;
