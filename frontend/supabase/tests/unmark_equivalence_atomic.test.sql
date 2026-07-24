-- Contrato de `remove_response_equivalence`: o par, o veredito da identidade
-- de trabalho de quem chama E o veredito do DONO do par saem na MESMA
-- transação (#545 — dissolver o par é evento do documento, e o gabarito do
-- dono apontava o grupo dissolvido); vereditos de outros revisores nunca saem
-- junto. Fixtures derivadas das que o PR #446 montou para a issue #427.
--
-- Um cenário por braço do predicado de autoridade — dona, conta-alias,
-- coordenadora, criadora não-membro, master —, mais outsider (nenhum braço) e
-- a prova de rollback. Criadora e master existem porque esta migration
-- REMOVEU o braço explícito `created_by = clerk_uid()` e passou a confiar em
-- `auth_user_coordinator_or_creator_project_ids()`: sem cenário próprio, uma
-- regressão no UNION daquele helper passaria sem vermelho.
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
  ('88888888-8888-8888-8888-888888888888', 'terceiro-427@example.test'),
  ('99999999-9999-9999-9999-999999999999', 'outsider-427@example.test'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'criadora-427@example.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'master-427@example.test');

-- `clerk_uid()` resolve a sessão por clerk_user_mapping, não pelo claim cru:
-- sem estas linhas a identidade seria NULL e todo cenário passaria por
-- "sem autoridade" — verde pelo motivo errado.
INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE email LIKE '%-427@example.test';

-- `is_master()` testa presença nesta tabela por `clerk_uid()`; a conta master
-- não é membro nem criadora do projeto, então é o único braço que a habilita.
INSERT INTO public.master_users (user_id) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

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
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '88888888-8888-8888-8888-888888888888',
    'pesquisador'
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
    '{"campo-dona":"a","campo-alias":"a","campo-coord":"a","campo-criadora":"a","campo-master":"a","campo-outsider":"a","campo-rollback":"a"}'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'humano',
    '11111111-1111-1111-1111-111111111111',
    '{"campo-dona":"b","campo-alias":"b","campo-coord":"b","campo-criadora":"b","campo-master":"b","campo-outsider":"b","campo-rollback":"b"}'
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
  (5, 'campo-rollback'),
  (6, 'campo-criadora'),
  (7, 'campo-master')
) AS cenario(n, campo);

-- Veredito da pesquisadora em cada campo, mais dois vereditos em 'campo-coord':
-- o da coordenadora (chamadora do cenário) e o de um TERCEIRO revisor — nem
-- dono nem chamador —, a fronteira nova do #545: só chamador + dono saem.
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
  ('campo-outsider'), ('campo-rollback'),
  ('campo-criadora'), ('campo-master')
) AS cenario(campo);

INSERT INTO public.reviews
  (project_id, document_id, field_name, reviewer_id, verdict)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  'campo-coord',
  '77777777-7777-7777-7777-777777777777',
  'resposta fundida'
),
(
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  'campo-coord',
  '88888888-8888-8888-8888-888888888888',
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

-- ========== Coordenadora desfaz par alheio: veredito do dono sai junto ======
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

  -- Decisão de produto do #545: dissolver o par é evento do documento, e o
  -- veredito da DONA — cujo gabarito apontava o grupo dissolvido — sai junto,
  -- forçando novo voto. (Inverte a fronteira que o #542 travava aqui.)
  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-coord'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU coordenadora: o veredito da dona do par sobreviveu';
  END IF;

  -- A fronteira que PERMANECE: o veredito de um terceiro revisor — nem dono
  -- nem chamador — no mesmo (documento, campo) nunca sai. Trocar o DELETE
  -- para varrer todos os reviewers do campo faria este teste falhar.
  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-coord'
    AND reviewer_id = '88888888-8888-8888-8888-888888888888';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenadora: apagou o veredito de terceiro revisor';
  END IF;

  -- E o alcance é por CAMPO: vereditos da própria dona em outros campos do
  -- documento não são tocados pela dissolução deste par.
  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-outsider'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU coordenadora: apagou veredito da dona em outro campo';
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

-- ========== Criadora não-membro: o braço unificado cobre `created_by` ========
-- A criadora não está em project_members: só `auth_user_coordinator_or_creator_project_ids()`
-- a autoriza. Este cenário é o vermelho que sobra se o UNION por `created_by`
-- daquele helper regredir — foi o braço explícito que esta migration removeu.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","supabase_uid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.remove_response_equivalence(
    '33333333-3333-3333-3333-333333333333',
    '60000006-0000-0000-0000-000000000000'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU criadora: RPC devolveu % linhas, esperava 1', n;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000006-0000-0000-0000-000000000000';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU criadora: o par não foi removido';
  END IF;

  -- Sem membership não há identidade de trabalho no projeto — o braço do
  -- chamador não casa nada —, mas o braço do DONO (#545) casa: o veredito da
  -- pesquisadora sai porque o grupo que ele apontava foi dissolvido.
  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-criadora'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU criadora: o veredito da dona do par sobreviveu';
  END IF;
END $$;

-- ========== Master: autoridade sem membership, mesma fronteira ==========
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","supabase_uid":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.remove_response_equivalence(
    '33333333-3333-3333-3333-333333333333',
    '60000007-0000-0000-0000-000000000000'
  );
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALHOU master: RPC devolveu % linhas, esperava 1', n;
  END IF;
END $$;

RESET ROLE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.response_equivalences
  WHERE id = '60000007-0000-0000-0000-000000000000';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU master: o par não foi removido';
  END IF;

  -- Mesma inversão do #545: master não tem identidade de trabalho no projeto,
  -- mas o veredito da dona sai pelo braço do dono do par.
  SELECT count(*) INTO n FROM public.reviews
  WHERE field_name = 'campo-master'
    AND reviewer_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALHOU master: o veredito da dona do par sobreviveu';
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
  msg text := NULL;
BEGIN
  -- O bloco EXCEPTION abre um savepoint: a exceção da RPC desfaz o que ela
  -- escreveu sem derrubar a transação do teste.
  BEGIN
    SELECT count(*) INTO n FROM public.remove_response_equivalence(
      '33333333-3333-3333-3333-333333333333',
      '60000005-0000-0000-0000-000000000000'
    );
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;

  IF msg IS NULL THEN
    RAISE EXCEPTION 'FALHOU rollback: a RPC não propagou a falha do DELETE';
  END IF;

  -- `WHEN OTHERS` captura qualquer erro — nome de função trocado, permissão
  -- negada, coluna inexistente. Sem casar a mensagem, o teste ficaria verde
  -- por um erro que não é o do trigger, provando rollback de coisa nenhuma.
  IF msg NOT LIKE '%falha forçada no DELETE de reviews (#427)%' THEN
    RAISE EXCEPTION
      'FALHOU rollback: erro inesperado, o vermelho não veio do trigger: %', msg;
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
