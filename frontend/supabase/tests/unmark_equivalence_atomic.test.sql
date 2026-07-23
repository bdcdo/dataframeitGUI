-- Contrato de `remove_response_equivalence`: o par e o veredito da identidade
-- de trabalho de quem chama saem na MESMA transação, e o veredito de terceiros
-- nunca sai junto. Fixtures derivadas das que o PR #446 montou para a issue
-- #427 (pesquisadora, conta-alias, coordenador, criador, master, outsider).
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/unmark_equivalence_atomic.test.sql
--
-- Validar pelo exit code, não por contar OKs na saída.
-- A transação termina em ROLLBACK e não deixa fixtures no banco local.

BEGIN;

-- As inserções em auth.users disparam handle_new_user e criam os profiles que
-- sustentam as FKs de reviewer_id.
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'dona-427@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'dona-alias-427@example.test'),
  ('77777777-7777-7777-7777-777777777777', 'coordenadora-427@example.test'),
  ('99999999-9999-9999-9999-999999999999', 'outsider-427@example.test'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'criadora-427@example.test');

-- `clerk_uid()` resolve a sessão por clerk_user_mapping, não pelo claim cru:
-- sem estas linhas a identidade seria NULL e todo cenário passaria por
-- "sem autoridade" — verde pelo motivo errado.
INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE email LIKE '%-427@example.test';

INSERT INTO public.projects (id, name, created_by) VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    'projeto unmark atomico #427',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'pesquisador'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '77777777-7777-7777-7777-777777777777',
    'coordenador'
  );

-- A conta-alias trabalha como a pesquisadora canônica.
INSERT INTO public.member_email_links
  (project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'dona-alias-427@example.test',
    '22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );

INSERT INTO public.documents (id, project_id, title, text) VALUES
  (
    '44444444-4444-4444-4444-444444444444',
    '33333333-3333-3333-3333-333333333333',
    'documento unmark atomico #427',
    'fixture'
  );

-- Uma resposta LLM e uma humana: `responses_one_latest_llm_per_document` admite
-- só uma LLM ativa por documento, e o par humano↔LLM é o caso real da tela de
-- Comparação.
INSERT INTO public.responses
  (id, project_id, document_id, respondent_type, respondent_id, answers)
VALUES
  (
    '50000000-0000-0000-0000-000000000001',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'llm',
    NULL,
    '{"campo-dona":"a","campo-alias":"a","campo-coord":"a","campo-outsider":"a","campo-rollback":"a"}'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'humano',
    '11111111-1111-1111-1111-111111111111',
    '{"campo-dona":"b","campo-alias":"b","campo-coord":"b","campo-outsider":"b","campo-rollback":"b"}'
  );

-- Um par por cenário; todos pertencem à pesquisadora canônica.
INSERT INTO public.response_equivalences (
  id, project_id, document_id, field_name,
  response_a_id, response_b_id, reviewer_id
)
SELECT
  ('6000000' || n || '-0000-0000-0000-000000000000')::UUID,
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  campo,
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002',
  '11111111-1111-1111-1111-111111111111'
FROM (VALUES
  (1, 'campo-dona'),
  (2, 'campo-alias'),
  (3, 'campo-coord'),
  (4, 'campo-outsider'),
  (5, 'campo-rollback')
) AS cenario(n, campo);

-- Veredito da pesquisadora em cada campo, mais um veredito da coordenadora
-- em 'campo-coord' (o cenário que separa "meu review" de "review alheio").
INSERT INTO public.reviews
  (project_id, document_id, field_name, reviewer_id, verdict)
SELECT
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  campo,
  '11111111-1111-1111-1111-111111111111',
  'resposta fundida'
FROM (VALUES
  ('campo-dona'), ('campo-alias'), ('campo-coord'),
  ('campo-outsider'), ('campo-rollback')
) AS cenario(campo);

INSERT INTO public.reviews
  (project_id, document_id, field_name, reviewer_id, verdict)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  'campo-coord',
  '77777777-7777-7777-7777-777777777777',
  'resposta fundida'
);

-- ========== A dona remove o próprio par ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","supabase_uid":"11111111-1111-1111-1111-111111111111"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.remove_response_equivalence(
    '33333333-3333-3333-3333-333333333333',
    '60000001-0000-0000-0000-000000000000'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU dona: RPC devolveu % linhas, esperava 1', n;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000001-0000-0000-0000-000000000000';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU dona: o par não foi removido';
  END IF;

  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-dona'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU dona: o veredito sobreviveu ao par (escrita parcial)';
  END IF;
END $$;

-- ========== A conta-alias age como a identidade canônica ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","supabase_uid":"22222222-2222-2222-2222-222222222222"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.remove_response_equivalence(
    '33333333-3333-3333-3333-333333333333',
    '60000002-0000-0000-0000-000000000000'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU alias: RPC devolveu % linhas, esperava 1', n;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000002-0000-0000-0000-000000000000';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU alias: o par não foi removido';
  END IF;

  -- O veredito apagado é o do MEMBRO CANÔNICO, não o do UUID bruto da conta
  -- vinculada: é o que impede a identidade de trabalho de se dividir em duas.
  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-alias'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU alias: veredito canônico sobreviveu ao par';
  END IF;
END $$;

-- ========== Coordenadora desfaz par alheio: não apaga trabalho de terceiro ==
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"77777777-7777-7777-7777-777777777777","supabase_uid":"77777777-7777-7777-7777-777777777777"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.remove_response_equivalence(
    '33333333-3333-3333-3333-333333333333',
    '60000003-0000-0000-0000-000000000000'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenadora: RPC devolveu % linhas, esperava 1', n;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000003-0000-0000-0000-000000000000';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU coordenadora: o par não foi removido';
  END IF;

  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-coord'
    AND reviewer_id = '77777777-7777-7777-7777-777777777777';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU coordenadora: o próprio veredito não foi removido';
  END IF;

  -- Decisão de produto travada aqui: o veredito da pesquisadora permanece.
  -- Trocar o predicado do DELETE por `equivalence.reviewer_id` faria este
  -- teste falhar — é a fronteira entre desfazer um par e apagar trabalho
  -- alheio.
  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-coord'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenadora: apagou o veredito da pesquisadora';
  END IF;
END $$;

-- ========== Outsider: nada removido, nenhuma linha devolvida ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"99999999-9999-9999-9999-999999999999","supabase_uid":"99999999-9999-9999-9999-999999999999"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.remove_response_equivalence(
    '33333333-3333-3333-3333-333333333333',
    '60000004-0000-0000-0000-000000000000'
  );
  -- Zero linhas é o sinal que a action converte em erro; se a RPC devolvesse
  -- a linha aqui, o guard do client viraria um sucesso falso legítimo.
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU outsider: RPC devolveu % linhas, esperava 0', n;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000004-0000-0000-0000-000000000000';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU outsider: o par alheio foi removido';
  END IF;

  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-outsider'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU outsider: apagou veredito de terceiro';
  END IF;
END $$;

-- ========== Falha no DELETE do review desfaz também a remoção do par ==========
-- A atomicidade é o motivo desta migration existir: enquanto o DELETE de
-- `reviews` vivia no client, falhar aqui deixava o par removido e o veredito
-- órfão. O trigger abaixo força exatamente essa falha.
CREATE FUNCTION public.fail_review_delete_427()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'falha forçada no DELETE de reviews (#427)';
END;
$$;

CREATE TRIGGER fail_review_delete_427
BEFORE DELETE ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.fail_review_delete_427();

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","supabase_uid":"11111111-1111-1111-1111-111111111111"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
  falhou boolean := false;
BEGIN
  -- O bloco EXCEPTION abre um savepoint: a exceção da RPC desfaz o que ela
  -- escreveu sem derrubar a transação do teste.
  BEGIN
    SELECT count(*) INTO n FROM public.remove_response_equivalence(
      '33333333-3333-3333-3333-333333333333',
      '60000005-0000-0000-0000-000000000000'
    );
  EXCEPTION WHEN OTHERS THEN
    falhou := true;
  END;

  IF NOT falhou THEN
    RAISE EXCEPTION 'FALHOU rollback: a RPC não propagou a falha do DELETE';
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000005-0000-0000-0000-000000000000';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU rollback: o par ficou removido apesar do erro';
  END IF;

  -- O carimbo de superseded também precisa ter voltado atrás.
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000005-0000-0000-0000-000000000000'
    AND superseded_at IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU rollback: superseded_at sobreviveu ao erro';
  END IF;
END $$;

DROP TRIGGER fail_review_delete_427 ON public.reviews;
DROP FUNCTION public.fail_review_delete_427();

ROLLBACK;
