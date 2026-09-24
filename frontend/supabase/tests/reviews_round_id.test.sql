-- Contrato de `reviews.round_id` (#733): a arbitragem pertence a uma rodada.
--
-- (b), (c) e (c4) sao replay do write real de `submitVerdict`
-- (frontend/src/actions/reviews.ts): um upsert em
-- UNIQUE(project_id, document_id, field_name, reviewer_id) cujo ON CONFLICT
-- atualiza a linha existente. E esse UPDATE que precisa recarimbar a rodada:
-- sem ele, rearbitrar na rodada nova deixaria a review na rodada antiga e fora
-- da fila. (c2) e a metade que discrimina: a rodada corrente muda de novo e um
-- update de manutencao (resolved_at) NAO pode mover a review, senao resolver o
-- comentario de uma review antiga a traria para a rodada atual. (c4) e o caso
-- que a revisao do PR achou: payload IDENTICO ao da linha (mesma resposta,
-- mesmo veredito) tambem recarimba, porque a trigger dispara pela coluna
-- mencionada no SET, nao pela mudanca de valor. (e2) fixa que so o servidor
-- carimba: cliente nao move a review de rodada nem dentro do projeto.
--
-- Roda numa transacao e nao deixa fixture no banco local.

BEGIN;

-- (a) Catalogo. Vem primeiro para que a ausencia da coluna produza uma
-- mensagem legivel em vez do 42703 cru que os blocos seguintes levantariam.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.reviews'::regclass
      AND attribute.attname = 'round_id'
      AND attribute.atttypid = 'uuid'::regtype
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'FALHOU: reviews.round_id nao existe como uuid NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.reviews'::regclass
      AND attribute.attname = 'project_id'
      AND attribute.attnotnull
  ) THEN
    RAISE EXCEPTION 'FALHOU: reviews.project_id continua nullable; a FK composta nao cobriria linha sem projeto';
  END IF;

  -- FK composta, nao `REFERENCES rounds(id)`: a simples aceitaria review de um
  -- projeto carimbada com rodada de outro.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.reviews'::regclass
      AND constraint_row.confrelid = 'public.rounds'::regclass
      AND constraint_row.contype = 'f'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
        ILIKE '%FOREIGN KEY (project_id, round_id) REFERENCES rounds(project_id, id)%'
  ) THEN
    RAISE EXCEPTION 'FALHOU: reviews nao ancora (project_id, round_id) em rounds';
  END IF;

  -- Tres gatilhos: INSERT preenche (funcao das tabelas irmas), UPDATE guarda a
  -- imutabilidade e UPDATE OF (colunas de conteudo) recarimba.
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_proc AS proc ON proc.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid = 'public.reviews'::regclass
      AND NOT trigger_row.tgisinternal
      AND proc.proname IN ('fill_current_round_id', 'enforce_review_round_immutable', 'stamp_review_round')
  ) <> 3 THEN
    RAISE EXCEPTION 'FALHOU: reviews nao tem os tres gatilhos de rodada';
  END IF;

  IF has_function_privilege('anon', 'public.stamp_review_round()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stamp_review_round()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.stamp_review_round()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_review_round_immutable()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: funcao de trigger de rodada executavel por cliente';
  END IF;

  RAISE NOTICE 'OK: catalogo tem round_id NOT NULL, FK composta e gatilhos fechados';
END;
$$;

INSERT INTO auth.users (id, email) VALUES
  ('7d000000-0000-0000-0000-000000000001', 'reviews-round-owner@example.test'),
  ('7d000000-0000-0000-0000-000000000002', 'reviews-round-reviewer@example.test'),
  ('7d000000-0000-0000-0000-000000000003', 'reviews-round-other@example.test');

-- A trigger `projects_create_initial_round` cria a rodada de cada projeto.
INSERT INTO public.projects (id, name, created_by) VALUES
  ('7d100000-0000-0000-0000-000000000001', 'arbitragem com rodada',
   '7d000000-0000-0000-0000-000000000001'),
  ('7d100000-0000-0000-0000-000000000002', 'projeto vizinho',
   '7d000000-0000-0000-0000-000000000001'),
  ('7d100000-0000-0000-0000-000000000003', 'projeto sem rodada',
   '7d000000-0000-0000-0000-000000000001');

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('7d200000-0000-0000-0000-000000000001', '7d100000-0000-0000-0000-000000000001',
   'Documento', 'Texto');

INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('7d300000-0000-0000-0000-000000000001', '7d100000-0000-0000-0000-000000000001',
   '7d200000-0000-0000-0000-000000000001', NULL, 'llm', '{"q":"LLM"}'),
  ('7d300000-0000-0000-0000-000000000002', '7d100000-0000-0000-0000-000000000001',
   '7d200000-0000-0000-0000-000000000001', '7d000000-0000-0000-0000-000000000002', 'humano', '{"q":"Humano"}');

-- (b) Replay do primeiro `submitVerdict`: o payload nao traz `round_id`.
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id, comment, response_snapshot)
VALUES (
  '7d400000-0000-0000-0000-000000000001',
  '7d100000-0000-0000-0000-000000000001',
  '7d200000-0000-0000-0000-000000000001',
  'q', '7d000000-0000-0000-0000-000000000002', 'Humano',
  '7d300000-0000-0000-0000-000000000002', NULL, NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.reviews AS review
    JOIN public.projects AS project ON project.id = review.project_id
    WHERE review.id = '7d400000-0000-0000-0000-000000000001'
      AND review.round_id = project.current_round_id
  ) THEN
    RAISE EXCEPTION 'FALHOU: INSERT sem round_id nao herdou a rodada corrente';
  END IF;
  RAISE NOTICE 'OK: review nasce carimbada com a rodada corrente do projeto';
END;
$$;

-- Segunda rodada, promovida a corrente: e o cenario da rearbitracao.
INSERT INTO public.rounds (id, project_id, label) VALUES
  ('7d500000-0000-0000-0000-000000000002',
   '7d100000-0000-0000-0000-000000000001', 'Rodada 2');
UPDATE public.projects
SET current_round_id = '7d500000-0000-0000-0000-000000000002'
WHERE id = '7d100000-0000-0000-0000-000000000001';

-- (c) Replay do upsert de `submitVerdict` na rodada nova: o PostgREST gera
-- ON CONFLICT DO UPDATE com as colunas do payload. O veredito muda, a linha e a
-- mesma, e a rodada tem que acompanhar.
INSERT INTO public.reviews (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id, comment, response_snapshot)
VALUES (
  '7d100000-0000-0000-0000-000000000001',
  '7d200000-0000-0000-0000-000000000001',
  'q', '7d000000-0000-0000-0000-000000000002', 'LLM',
  '7d300000-0000-0000-0000-000000000001', NULL, NULL
)
ON CONFLICT (project_id, document_id, field_name, reviewer_id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  document_id = EXCLUDED.document_id,
  field_name = EXCLUDED.field_name,
  reviewer_id = EXCLUDED.reviewer_id,
  verdict = EXCLUDED.verdict,
  chosen_response_id = EXCLUDED.chosen_response_id,
  comment = EXCLUDED.comment,
  response_snapshot = EXCLUDED.response_snapshot;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.reviews WHERE project_id = '7d100000-0000-0000-0000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'FALHOU: o upsert criou uma segunda linha em vez de atualizar';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '7d400000-0000-0000-0000-000000000001'
      AND verdict = 'LLM'
      AND round_id = '7d500000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU: rearbitracao nao moveu a review para a rodada corrente';
  END IF;
  RAISE NOTICE 'OK: rearbitrar na rodada nova recarimba a review';
END;
$$;

-- Terceira rodada corrente, para que (c2) tenha um valor distinto do carimbo:
-- se a manutencao recarimbasse, a review iria para a Rodada 3.
INSERT INTO public.rounds (id, project_id, label) VALUES
  ('7d500000-0000-0000-0000-000000000003',
   '7d100000-0000-0000-0000-000000000001', 'Rodada 3');
UPDATE public.projects
SET current_round_id = '7d500000-0000-0000-0000-000000000003'
WHERE id = '7d100000-0000-0000-0000-000000000001';

-- (c2) Manutencao: resolver o comentario (actions/stats.ts) e editar so o
-- comentario nao movem a review de rodada.
UPDATE public.reviews
SET resolved_at = now(), resolved_by = '7d000000-0000-0000-0000-000000000001', comment = 'Conferido'
WHERE id = '7d400000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews AS review
    JOIN public.projects AS project ON project.id = review.project_id
    WHERE review.id = '7d400000-0000-0000-0000-000000000001'
      AND review.round_id = '7d500000-0000-0000-0000-000000000002'
      -- O discriminante: e esta metade que morre se a trigger recarimbar em
      -- todo UPDATE.
      AND review.round_id IS DISTINCT FROM project.current_round_id
      AND review.resolved_at IS NOT NULL
      AND review.comment = 'Conferido'
  ) THEN
    RAISE EXCEPTION 'FALHOU: update de manutencao moveu a review de rodada';
  END IF;
  RAISE NOTICE 'OK: resolver ou comentar nao move a review de rodada';
END;
$$;

-- (c3) Mudar so o snapshot da resposta escolhida conta como conteudo: e o que
-- `confirmEquivalentVerdict` grava ao confirmar um veredito equivalente.
UPDATE public.reviews
SET response_snapshot = '{"q":"LLM"}'::jsonb
WHERE id = '7d400000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '7d400000-0000-0000-0000-000000000001'
      AND round_id = '7d500000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'FALHOU: mudanca de response_snapshot nao recarimbou a rodada';
  END IF;
  RAISE NOTICE 'OK: snapshot novo move a review para a rodada corrente';
END;
$$;

-- (c4) Quarta rodada corrente e o upsert de `submitVerdict` com payload
-- IDENTICO ao da linha: rodada nova em que o documento nao foi recodificado e o
-- revisor confirma a mesma resposta com o mesmo veredito. Nada muda de valor,
-- e mesmo assim a review tem que ir para a rodada corrente, senao some da
-- fila sem conserto pela UI.
INSERT INTO public.rounds (id, project_id, label) VALUES
  ('7d500000-0000-0000-0000-000000000004',
   '7d100000-0000-0000-0000-000000000001', 'Rodada 4');
UPDATE public.projects
SET current_round_id = '7d500000-0000-0000-0000-000000000004'
WHERE id = '7d100000-0000-0000-0000-000000000001';

INSERT INTO public.reviews (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id, comment, response_snapshot)
VALUES (
  '7d100000-0000-0000-0000-000000000001',
  '7d200000-0000-0000-0000-000000000001',
  'q', '7d000000-0000-0000-0000-000000000002', 'LLM',
  '7d300000-0000-0000-0000-000000000001', 'Conferido', '{"q":"LLM"}'::jsonb
)
ON CONFLICT (project_id, document_id, field_name, reviewer_id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  document_id = EXCLUDED.document_id,
  field_name = EXCLUDED.field_name,
  reviewer_id = EXCLUDED.reviewer_id,
  verdict = EXCLUDED.verdict,
  chosen_response_id = EXCLUDED.chosen_response_id,
  comment = EXCLUDED.comment,
  response_snapshot = EXCLUDED.response_snapshot;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '7d400000-0000-0000-0000-000000000001'
      AND round_id = '7d500000-0000-0000-0000-000000000004'
  ) THEN
    RAISE EXCEPTION 'FALHOU: upsert com payload identico nao recarimbou a rodada';
  END IF;
  RAISE NOTICE 'OK: rearbitrar com o mesmo conteudo tambem move a review para a rodada corrente';
END;
$$;

-- (d) Valor explicito no INSERT sobrevive a trigger, como em fill_current_round_id.
INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, round_id)
VALUES (
  '7d400000-0000-0000-0000-000000000002',
  '7d100000-0000-0000-0000-000000000001',
  '7d200000-0000-0000-0000-000000000001',
  'q', '7d000000-0000-0000-0000-000000000003', 'ambiguo',
  '7d500000-0000-0000-0000-000000000002'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id = '7d400000-0000-0000-0000-000000000002'
      AND round_id = '7d500000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU: INSERT com rodada explicita foi sobrescrito pela trigger';
  END IF;
  RAISE NOTICE 'OK: rodada explicita no INSERT sobrevive a trigger';
END;
$$;

-- (e) A FK composta recusa rodada de outro projeto no INSERT; projeto sem
-- rodada corrente e irrepresentavel no INSERT; e o cascade de `projects`
-- sobrevive a FK NO ACTION.
-- (e2) No UPDATE, `round_id` e do servidor: o cliente nao move a review nem
-- para outra rodada do proprio projeto (23514, como em `responses`).
UPDATE public.projects
SET current_round_id = NULL
WHERE id = '7d100000-0000-0000-0000-000000000003';

DO $$
DECLARE
  v_foreign_round uuid;
BEGIN
  SELECT current_round_id INTO STRICT v_foreign_round
  FROM public.projects WHERE id = '7d100000-0000-0000-0000-000000000002';

  BEGIN
    INSERT INTO public.reviews (project_id, document_id, field_name, reviewer_id, verdict, round_id)
    VALUES ('7d100000-0000-0000-0000-000000000001', '7d200000-0000-0000-0000-000000000001',
            'q', '7d000000-0000-0000-0000-000000000001', 'ambiguo', v_foreign_round);
    RAISE EXCEPTION 'TESTE FALHOU: review aceitou rodada de outro projeto';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE public.reviews
    SET round_id = '7d500000-0000-0000-0000-000000000003'
    WHERE id = '7d400000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'TESTE FALHOU: cliente moveu a review de rodada dentro do projeto';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.reviews (project_id, field_name, verdict)
    VALUES ('7d100000-0000-0000-0000-000000000003', 'q', 'ambiguo');
    RAISE EXCEPTION 'TESTE FALHOU: review de projeto sem rodada foi aceita';
  EXCEPTION
    WHEN not_null_violation THEN
      NULL;
  END;

  DELETE FROM public.projects
  WHERE id = '7d100000-0000-0000-0000-000000000001';

  IF EXISTS (
    SELECT 1 FROM public.reviews
    WHERE id IN ('7d400000-0000-0000-0000-000000000001', '7d400000-0000-0000-0000-000000000002')
  ) THEN
    RAISE EXCEPTION 'FALHOU: exclusao do projeto nao removeu as reviews';
  END IF;

  RAISE NOTICE 'OK: rodada e do proprio projeto e o cascade sobrevive a FK';
END;
$$;

ROLLBACK;
