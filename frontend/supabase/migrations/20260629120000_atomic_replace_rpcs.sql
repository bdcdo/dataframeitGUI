-- RPCs transacionais para fechar a janela de não-atomicidade de duas escritas
-- multi-passo que hoje rodam como chamadas PostgREST separadas (sem transação):
--
--   #181  smartRandomize (sorteio, modo "substituir"): DELETE das pendentes +
--         INSERT das novas. Falha entre os dois perde as pendentes.
--   #284  uploadDocuments (replace_and_add com deleteResponses): DELETE reviews
--         + DELETE responses + UPDATE assignments + UPDATE duplicados + INSERT
--         novos. Falha no INSERT deixava respostas/revisões já apagadas, sem
--         rollback — perda de dado humano irreversível.
--
-- Ambas as funções rodam como SECURITY INVOKER (não DEFINER): chamadas pelo
-- client autenticado (lib/supabase/server.ts), o JWT do Clerk continua no
-- contexto, então (a) as RLS policies de coordenador continuam valendo dentro
-- da função e (b) os triggers enforce_*_column_guard (que fazem bypass quando
-- clerk_uid() é NULL = service-role) NÃO são desligados — ao contrário do que
-- aconteceria com SECURITY DEFINER + service_role. Direção alinhada às issues
-- de segurança #137 (reduzir uso do admin client), #134 (RLS consistente) e
-- #243 (column guards). search_path = '' por higiene (tudo qualificado com
-- public.). GRANT só a authenticated (sem REVOKE especial — não precisa).

-- ========== #181: sorteio ==========
-- Quando p_replace é true, descarta as pendentes do tipo antes de inserir; o
-- DELETE+INSERT numa transação só resolve tanto a janela de perda quanto a
-- colisão com UNIQUE(document_id, user_id, type) (que impede inverter a ordem).
-- p_assignments é um array de objetos { document_id, user_id }. Dispensa o
-- chunking de 100 do lado TS (aquilo era limite de payload PostgREST, não SQL).
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

  INSERT INTO public.assignments (project_id, document_id, user_id, batch_id, type)
  SELECT p_project_id,
         (e->>'document_id')::uuid,
         (e->>'user_id')::uuid,
         p_batch_id,
         p_type
  FROM jsonb_array_elements(p_assignments) AS e;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean)
  TO authenticated;

-- ========== #284: upload replace_and_add ==========
-- Os 5 passos numa transação implícita: erro em qualquer um faz ROLLBACK de
-- tudo. O pré-filtro de conflito de external_id (filterActiveExternalIdConflicts)
-- continua no TS por ser read-only — p_new_documents já chega filtrado.
--   p_duplicate_updates: array de { id, text, title, external_id, text_hash, metadata }
--   p_new_documents:     array de { external_id, title, text, text_hash, metadata }
-- text_hash chega precomputado (md5) do TS, para paridade exata com o caminho
-- antigo. Retorna o número de documentos novos inseridos.
CREATE OR REPLACE FUNCTION public.replace_and_add_documents(
  p_project_id uuid,
  p_existing_doc_ids uuid[],
  p_delete_responses boolean,
  p_duplicate_updates jsonb,
  p_new_documents jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF p_delete_responses
     AND p_existing_doc_ids IS NOT NULL
     AND array_length(p_existing_doc_ids, 1) > 0 THEN
    -- reviews antes (FK chosen_response_id -> responses sem CASCADE)
    DELETE FROM public.reviews
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    DELETE FROM public.responses
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);

    UPDATE public.assignments
    SET status = 'pendente'
    WHERE project_id = p_project_id
      AND document_id = ANY(p_existing_doc_ids);
  END IF;

  IF p_duplicate_updates IS NOT NULL
     AND jsonb_array_length(p_duplicate_updates) > 0 THEN
    UPDATE public.documents d
    SET text = u."text",
        title = u.title,
        external_id = u.external_id,
        text_hash = u.text_hash,
        metadata = u.metadata
    FROM jsonb_to_recordset(p_duplicate_updates)
      AS u(id uuid, "text" text, title text, external_id text,
           text_hash text, metadata jsonb)
    WHERE d.id = u.id;
  END IF;

  IF p_new_documents IS NOT NULL
     AND jsonb_array_length(p_new_documents) > 0 THEN
    INSERT INTO public.documents
      (project_id, external_id, title, text, text_hash, metadata)
    SELECT p_project_id, n.external_id, n.title, n."text", n.text_hash, n.metadata
    FROM jsonb_to_recordset(p_new_documents)
      AS n(external_id text, title text, "text" text,
           text_hash text, metadata jsonb);
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.replace_and_add_documents(uuid, uuid[], boolean, jsonb, jsonb)
  TO authenticated;
