-- #521: o assignment de codificação nasce com o status que a response já provou.
--
-- Quem codifica um documento pelo Explorar (antes de existir atribuição) ficava
-- eternamente "pendente" na fila: o sorteio criava a linha com o DEFAULT da
-- coluna e nada a promovia depois — `syncCodingAssignmentStatus` (TS) só roda no
-- save de uma response, e o save já tinha acontecido. Em vez de reconciliar
-- depois (janela em que a fila mente, e um UPDATE que pode falhar), o INSERT
-- passa a gravar o status derivado, tornando o estado ruim não construível.
--
-- Redefinição por CREATE OR REPLACE preservando assinatura, SECURITY INVOKER e
-- search_path — mesmo padrão de 20260716120000_comparacao_single_reviewer_rpcs.
-- A definição vigente vem daquela migration (#181/#490); o único delta aqui são
-- as duas colunas novas no INSERT.
--
-- `status`/`completed_at` viajam DENTRO de p_assignments (jsonb), então a
-- assinatura não muda. O COALESCE mantém a função compatível com o payload que
-- omite as chaves: é o caso do sorteio de COMPARAÇÃO, que segue mandando só
-- document_id/user_id. Quem calcula o status é o TS (computeLottery →
-- resolveInitialCodingStatus), porque a régua de "codificação completa" é
-- `isCodingComplete` — replicá-la em SQL criaria uma terceira cópia da regra
-- para divergir da do servidor.
CREATE OR REPLACE FUNCTION public.apply_lottery_assignments(
  p_project_id uuid,
  p_type text,
  p_batch_id uuid,
  p_assignments jsonb,
  p_replace boolean
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_replace THEN
    DELETE FROM public.assignments
    WHERE project_id = p_project_id
      AND status = 'pendente'
      AND type = p_type;
  END IF;

  -- ON CONFLICT DO NOTHING sem target: ver 20260716120000 (#490). O conflito
  -- esperado é a corrida com o gatilho automático da comparação; sem target,
  -- cobre tanto a UNIQUE(document_id, user_id, type) quanto o índice parcial
  -- assignments_one_active_comparacao_per_doc.
  INSERT INTO public.assignments (
    project_id, document_id, user_id, batch_id, type, status, completed_at
  )
  SELECT p_project_id,
         (e->>'document_id')::uuid,
         (e->>'user_id')::uuid,
         p_batch_id,
         p_type,
         COALESCE(e->>'status', 'pendente'),
         (e->>'completed_at')::timestamptz
  FROM jsonb_array_elements(p_assignments) AS e
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean)
  TO authenticated;
