-- O reconhecimento de veredito ("Aceitar correção", "Comentar dúvida") fica
-- preso ao conteúdo do veredito reconhecido (#758).
--
-- O upsert de rearbitragem de `submitVerdict` reaproveita o `reviews.id`, e o
-- reconhecimento, que só guardava `review_id`, sobrevivia a um veredito novo:
-- o pesquisador aparecia como ciente de um veredito que nunca viu.
-- `acknowledged_verdict` guarda o texto do veredito reconhecido, e o gatilho
-- só aceita gravar o reconhecimento com o veredito atual da review, que o
-- cliente manda (o que a tela mostrou); a review mudou no meio do caminho,
-- recusa com 40001.
--
-- Roda numa transação e não deixa fixture no banco local.

BEGIN;

-- Catálogo primeiro: sem a coluna, a mensagem é legível em vez do 42703 cru.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.verdict_acknowledgments'::regclass AND attname = 'acknowledged_verdict'
      AND atttypid = 'text'::regtype AND attnotnull AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'FALHOU: verdict_acknowledgments.acknowledged_verdict não existe como text NOT NULL';
  END IF;
  IF has_function_privilege('authenticated', 'public.enforce_verdict_acknowledgment_current()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.enforce_verdict_acknowledgment_current()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: função de gatilho do reconhecimento executável por cliente';
  END IF;
  RAISE NOTICE 'OK: catálogo';
END $$;

INSERT INTO auth.users (id, email) VALUES
  ('b1c00000-0000-0000-0000-000000000001', 'ack-owner@example.test'),
  ('b1c00000-0000-0000-0000-000000000002', 'ack-coder@example.test'),
  ('b1c00000-0000-0000-0000-000000000003', 'ack-outsider@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'b1c00000-%';
INSERT INTO public.projects (id, name, created_by, pydantic_fields) VALUES
  ('b1c10000-0000-0000-0000-000000000001', 'Ack test', 'b1c00000-0000-0000-0000-000000000001',
   '[{"id":"b1f10000-0000-4000-8000-000000000001","name":"q","type":"single","options":["Sim","Não"],"description":"P","hash":"q00000000001"}]');
INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('b1c10000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000002', 'pesquisador');
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('b1c20000-0000-0000-0000-000000000001', 'b1c10000-0000-0000-0000-000000000001', 'Documento', 'Texto');
INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('b1c30000-0000-0000-0000-000000000001', 'b1c10000-0000-0000-0000-000000000001', 'b1c20000-0000-0000-0000-000000000001',
   'b1c00000-0000-0000-0000-000000000002', 'humano', '{"q":"Não"}');
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id) VALUES
  ('b1c40000-0000-0000-0000-000000000001', 'b1c10000-0000-0000-0000-000000000001', 'b1c20000-0000-0000-0000-000000000001', 'q',
   'b1c00000-0000-0000-0000-000000000001', 'Sim', NULL);

-- O pesquisador reconhece o veredito que a tela mostrou.
SELECT set_config('request.jwt.claims', '{"sub":"b1c00000-0000-0000-0000-000000000002","supabase_uid":"b1c00000-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  -- Veredito que não é o atual: a tela estava velha.
  BEGIN
    INSERT INTO public.verdict_acknowledgments (review_id, respondent_id, status, acknowledged_verdict)
    VALUES ('b1c40000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000002', 'accepted', 'Não');
    RAISE EXCEPTION 'FALHOU: reconhecimento de veredito que não é o atual foi aceito';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  -- Sem dizer qual veredito reconheceu: recusado.
  BEGIN
    INSERT INTO public.verdict_acknowledgments (review_id, respondent_id, status)
    VALUES ('b1c40000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000002', 'accepted');
    RAISE EXCEPTION 'FALHOU: reconhecimento sem veredito foi aceito';
  EXCEPTION WHEN serialization_failure OR not_null_violation THEN NULL;
  END;
  INSERT INTO public.verdict_acknowledgments (review_id, respondent_id, status, comment, acknowledged_verdict)
  VALUES ('b1c40000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000002', 'questioned', 'Por quê?', 'Sim');
  RAISE NOTICE 'OK: o reconhecimento guarda o veredito que a tela mostrou';
END $$;
RESET ROLE;

-- Rearbitragem pelo mesmo upsert de submitVerdict: a review mantém o id e
-- muda o veredito. O reconhecimento continua gravado, preso ao veredito antigo.
UPDATE public.reviews SET verdict = 'Não' WHERE id = 'b1c40000-0000-0000-0000-000000000001';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.verdict_acknowledgments AS ack
    JOIN public.reviews AS review ON review.id = ack.review_id
    WHERE ack.review_id = 'b1c40000-0000-0000-0000-000000000001'
      AND ack.acknowledged_verdict = 'Sim' AND review.verdict = 'Não'
  ) THEN
    RAISE EXCEPTION 'FALHOU: rearbitragem deveria deixar o reconhecimento preso ao veredito antigo';
  END IF;
  RAISE NOTICE 'OK: rearbitragem não herda o reconhecimento';
END $$;

-- O coordenador resolve a dúvida antiga: manutenção não carimba nem é
-- recusada pelo veredito ter mudado.
SELECT set_config('request.jwt.claims', '{"sub":"b1c00000-0000-0000-0000-000000000001","supabase_uid":"b1c00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  UPDATE public.verdict_acknowledgments SET resolved_at = now(), resolved_by = 'b1c00000-0000-0000-0000-000000000001'
  WHERE review_id = 'b1c40000-0000-0000-0000-000000000001';
  IF NOT FOUND THEN RAISE EXCEPTION 'FALHOU: coordenador não resolveu a dúvida'; END IF;
  IF (SELECT acknowledged_verdict FROM public.verdict_acknowledgments WHERE review_id = 'b1c40000-0000-0000-0000-000000000001') <> 'Sim' THEN
    RAISE EXCEPTION 'FALHOU: resolver a dúvida moveu o veredito reconhecido';
  END IF;
  RAISE NOTICE 'OK: manutenção do coordenador não mexe no veredito reconhecido';
END $$;
RESET ROLE;

-- O pesquisador reconhece de novo, pelo mesmo upsert do app: com o veredito
-- novo, aceito; com o antigo, recusado; e um PATCH não o troca por outro texto.
SELECT set_config('request.jwt.claims', '{"sub":"b1c00000-0000-0000-0000-000000000002","supabase_uid":"b1c00000-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.verdict_acknowledgments (review_id, respondent_id, status, comment, acknowledged_verdict)
    VALUES ('b1c40000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000002', 'accepted', NULL, 'Sim')
    ON CONFLICT (review_id, respondent_id) DO UPDATE
      SET status = EXCLUDED.status, comment = EXCLUDED.comment, acknowledged_verdict = EXCLUDED.acknowledged_verdict;
    RAISE EXCEPTION 'FALHOU: reconhecer de novo com o veredito antigo foi aceito';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    UPDATE public.verdict_acknowledgments SET acknowledged_verdict = 'Talvez'
    WHERE review_id = 'b1c40000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: PATCH trocou o veredito reconhecido por um que a review não tem';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    UPDATE public.verdict_acknowledgments SET status = 'accepted'
    WHERE review_id = 'b1c40000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: mudar o status sem reconhecer o veredito atual foi aceito';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  INSERT INTO public.verdict_acknowledgments (review_id, respondent_id, status, comment, acknowledged_verdict)
  VALUES ('b1c40000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000002', 'accepted', NULL, 'Não')
  ON CONFLICT (review_id, respondent_id) DO UPDATE
    SET status = EXCLUDED.status, comment = EXCLUDED.comment, acknowledged_verdict = EXCLUDED.acknowledged_verdict;
  IF (SELECT acknowledged_verdict FROM public.verdict_acknowledgments WHERE review_id = 'b1c40000-0000-0000-0000-000000000001') <> 'Não' THEN
    RAISE EXCEPTION 'FALHOU: reconhecer de novo não gravou o veredito atual';
  END IF;
  RAISE NOTICE 'OK: reconhecer de novo exige o veredito atual';
END $$;
RESET ROLE;

-- Quem não é do projeto não descobre o texto do veredito pelo erro: com o
-- veredito certo ou errado, a recusa é a mesma, a da policy.
SELECT set_config('request.jwt.claims', '{"sub":"b1c00000-0000-0000-0000-000000000003","supabase_uid":"b1c00000-0000-0000-0000-000000000003"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE guess TEXT;
BEGIN
  FOREACH guess IN ARRAY ARRAY['Não', 'Sim'] LOOP
    BEGIN
      INSERT INTO public.verdict_acknowledgments (review_id, respondent_id, status, acknowledged_verdict)
      VALUES ('b1c40000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000003', 'accepted', guess);
      RAISE EXCEPTION 'FALHOU: quem não é do projeto reconheceu veredito';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  RAISE NOTICE 'OK: o gatilho não vira oráculo do veredito para quem não é do projeto';
END $$;
RESET ROLE;

ROLLBACK;
