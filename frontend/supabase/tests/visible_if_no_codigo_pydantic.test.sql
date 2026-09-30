-- Contrato da migration 20260930150000_visible_if_no_codigo_pydantic: a chave
-- da condição de visibilidade no código Pydantic armazenado troca de
-- `"condition"` para `"visible_if"`, só dentro de `json_schema_extra`.
--
-- pydantic_code_visibility_renamed é a regra que a migration aplicou. Os casos
-- conferem que ela troca a chave, não toca texto de usuário (o gerador escapa as
-- aspas, e a de fechamento escapada, `condition\":`, não casa), é idempotente e preserva código sem condição e NULL; e que o
-- UPDATE com a regra, o hash de commit_project_schema e o incremento de
-- schema_revision passa pelo gatilho de revisão.
--
-- Como rodar (apos `npx supabase start` e `npx supabase db reset`):
--   bash scripts/run-sql-test.sh supabase/tests/visible_if_no_codigo_pydantic.test.sql
--
-- Roda inteiro em BEGIN ... ROLLBACK; nao deixa fixtures no banco local.

BEGIN;

DO $$
DECLARE
  v_antigo text := 'class Analysis(BaseModel):' || chr(10)
    || '    q1: Literal["Sim", "Não"] = Field(description="Houve?", json_schema_extra={"id": "a"})' || chr(10)
    || '    q2: Optional[str] = Field(default=None, description="Qual? \"condition\": {nao e chave}", '
    || 'json_schema_extra={"id": "b", "help_text": "h", "condition": {"field": "q1", "equals": "Sim"}, '
    || '"justification_prompt": "j"})' || chr(10)
    || '    q3: Optional[str] = Field(default=None, description="d", '
    || 'json_schema_extra={"id": "c", "condition": {"field": "q1", "exists": True}})';
  v_novo text;
BEGIN
  v_novo := public.pydantic_code_visibility_renamed(v_antigo);

  IF v_novo IS DISTINCT FROM replace(
       replace(v_antigo,
         ', "condition": {"field": "q1", "equals"', ', "visible_if": {"field": "q1", "equals"'),
         ', "condition": {"field": "q1", "exists"', ', "visible_if": {"field": "q1", "exists"') THEN
    RAISE EXCEPTION 'FALHOU: a troca não é a esperada: %', v_novo;
  END IF;
  IF position('\"condition\": {nao e chave}' IN v_novo) = 0 THEN
    RAISE EXCEPTION 'FALHOU: texto de usuário com aspas escapadas foi alterado';
  END IF;
  IF public.pydantic_code_visibility_renamed(v_novo) IS DISTINCT FROM v_novo THEN
    RAISE EXCEPTION 'FALHOU: a troca não é idempotente';
  END IF;
  IF public.pydantic_code_visibility_renamed('class A(BaseModel):' || chr(10) || '    x: str')
     IS DISTINCT FROM 'class A(BaseModel):' || chr(10) || '    x: str' THEN
    RAISE EXCEPTION 'FALHOU: código sem condição foi alterado';
  END IF;
  IF public.pydantic_code_visibility_renamed(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: NULL virou texto';
  END IF;
END;
$$;

INSERT INTO auth.users (id, email) VALUES
  ('7d000000-0000-0000-0000-000000000001', 'visible-if@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('7d000000-0000-0000-0000-000000000001',
   '7d000000-0000-0000-0000-000000000001', 1);

INSERT INTO public.projects (id, name, created_by, pydantic_fields, pydantic_code) VALUES
  ('7d100000-0000-0000-0000-000000000001', 'visible if',
   '7d000000-0000-0000-0000-000000000001', '[]',
   'x: Optional[str] = Field(default=None, json_schema_extra={"condition": {"field": "y", "equals": "a"}})');

DO $$
DECLARE
  v_revisao integer;
  v_code text;
  v_hash text;
BEGIN
  SELECT schema_revision INTO v_revisao
    FROM public.projects WHERE id = '7d100000-0000-0000-0000-000000000001';

  UPDATE public.projects p
  SET pydantic_code = public.pydantic_code_visibility_renamed(p.pydantic_code),
      pydantic_hash = substring(
        encode(extensions.digest(public.pydantic_code_visibility_renamed(p.pydantic_code), 'sha256'), 'hex')
        FROM 1 FOR 16),
      schema_revision = p.schema_revision + 1
  WHERE p.id = '7d100000-0000-0000-0000-000000000001';

  SELECT pydantic_code, pydantic_hash INTO v_code, v_hash
    FROM public.projects WHERE id = '7d100000-0000-0000-0000-000000000001';
  IF v_code IS DISTINCT FROM
     'x: Optional[str] = Field(default=None, json_schema_extra={"visible_if": {"field": "y", "equals": "a"}})' THEN
    RAISE EXCEPTION 'FALHOU: código não migrou: %', v_code;
  END IF;
  IF v_hash IS DISTINCT FROM substring(encode(extensions.digest(v_code, 'sha256'), 'hex') FROM 1 FOR 16) THEN
    RAISE EXCEPTION 'FALHOU: hash não é o de commit_project_schema';
  END IF;
  IF (SELECT schema_revision FROM public.projects
       WHERE id = '7d100000-0000-0000-0000-000000000001') IS DISTINCT FROM v_revisao + 1 THEN
    RAISE EXCEPTION 'FALHOU: schema_revision não subiu uma vez';
  END IF;
END;
$$;

\echo 'visible_if_no_codigo_pydantic: OK'

ROLLBACK;
