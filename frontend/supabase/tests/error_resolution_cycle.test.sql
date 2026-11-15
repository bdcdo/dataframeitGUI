-- Ciclo da fila do LLM Insights no banco (#745): a ação do card grava pela
-- RPC (set_error_resolution, record_value_equivalences), e a carga seguinte lê
-- pelo read_error_resolutions e pela query de value_equivalences da página.
--
-- O fixture abaixo é a fonte única dos dois lados:
--   - esta suíte monta o projeto a partir de "input", roda as RPCs como a
--     coordenadora e confere que o banco devolve exatamente "expected";
--   - src/lib/__tests__/error-resolution-cycle.test.ts lê o MESMO bloco deste
--     arquivo e confere que computeLlmErrorMetrics + errorQueueTab classificam
--     essa saída como a ação prometeu (a decisão tira o card dos abertos, o
--     "=" tira o card da fila).
-- O teste de propriedade do #893 parte da linha que ele próprio monta; aqui a
-- linha é a que o banco devolve. Um current_context reconstruído em outra
-- forma deixaria a decisão "Fontes alteradas" (stale), aberta, e quebra um dos
-- dois lados.
--
-- Valores opacos (rodada criada pelo trigger, hashes das respostas) são
-- conferidos crus, contexto contra contexto corrente, e só depois trocados por
-- marcadores iguais nos dois lados. O id e a data da decisão também viram
-- marcadores. Quando o formato mudar de propósito, a falha imprime o JSON
-- normalizado que o banco devolveu, para atualizar o fixture.

BEGIN;

SELECT set_config('test.cycle_fixture', $fixture$
{
  "input": {
    "project_id": "c5b00000-0000-0000-0000-000000000001",
    "coordinator_id": "c5a00000-0000-0000-0000-000000000001",
    "coder_id": "c5a00000-0000-0000-0000-000000000002",
    "fields": [
      {"id": "c5f10000-0000-4000-8000-000000000001", "name": "q", "type": "text",
       "description": "Pergunta", "options": null, "hash": "c5c5c5c5c5c5"}
    ],
    "cells": [
      {"document_id": "c5c00000-0000-0000-0000-000000000001", "llm_response_id": "c5d00000-0000-0000-0000-000000000001",
       "human_response_id": "c5d10000-0000-0000-0000-000000000001", "review_id": "c5e00000-0000-0000-0000-000000000001",
       "action": "llm_correct", "value": null, "llm_answer": "LLM", "human_answer": "Humano"},
      {"document_id": "c5c00000-0000-0000-0000-000000000002", "llm_response_id": "c5d00000-0000-0000-0000-000000000002",
       "human_response_id": "c5d10000-0000-0000-0000-000000000002", "review_id": "c5e00000-0000-0000-0000-000000000002",
       "action": "researchers_correct", "value": "Veredito", "llm_answer": "LLM", "human_answer": "Humano"},
      {"document_id": "c5c00000-0000-0000-0000-000000000003", "llm_response_id": "c5d00000-0000-0000-0000-000000000003",
       "human_response_id": "c5d10000-0000-0000-0000-000000000003", "review_id": "c5e00000-0000-0000-0000-000000000003",
       "action": "both_correct", "value": null, "llm_answer": "LLM", "human_answer": "Humano"},
      {"document_id": "c5c00000-0000-0000-0000-000000000004", "llm_response_id": "c5d00000-0000-0000-0000-000000000004",
       "human_response_id": "c5d10000-0000-0000-0000-000000000004", "review_id": "c5e00000-0000-0000-0000-000000000004",
       "action": "all_wrong", "value": "Terceira", "llm_answer": "LLM", "human_answer": "Humano"},
      {"document_id": "c5c00000-0000-0000-0000-000000000005", "llm_response_id": "c5d00000-0000-0000-0000-000000000005",
       "human_response_id": "c5d10000-0000-0000-0000-000000000005", "review_id": "c5e00000-0000-0000-0000-000000000005",
       "action": "discussion", "value": null, "llm_answer": "LLM", "human_answer": "Humano"},
      {"document_id": "c5c00000-0000-0000-0000-000000000006", "llm_response_id": "c5d00000-0000-0000-0000-000000000006",
       "human_response_id": "c5d10000-0000-0000-0000-000000000006", "review_id": "c5e00000-0000-0000-0000-000000000006",
       "action": "equivalent", "value": null, "llm_answer": "NI", "human_answer": "N/A"}
    ]
  },
  "expected": {
    "read_error_resolutions": [
      {"id": "<id>", "project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000001",
       "field_name": "q", "decision": "llm_correct", "resolved_at": "<resolved_at>",
       "resolved_by": "c5a00000-0000-0000-0000-000000000001", "note": "Conferido", "approved_value": null,
       "context": {"project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000001",
         "field_name": "q", "round_id": "<round>", "automation_mode": "compare_llm",
         "field_definition": {"id": "c5f10000-0000-4000-8000-000000000001", "name": "q", "type": "text",
           "description": "Pergunta", "options": null, "hash": "c5c5c5c5c5c5"},
         "llm_response_id": "c5d00000-0000-0000-0000-000000000001", "human_response_id": "c5d10000-0000-0000-0000-000000000001",
         "llm_value": {"present": true, "value": "LLM"}, "human_value": {"present": true, "value": "Humano"},
         "source": {"kind": "comparacao", "id": "c5e00000-0000-0000-0000-000000000001", "verdict": "Humano",
           "chosen_response_id": "c5d10000-0000-0000-0000-000000000001", "response_snapshot": null, "comment": null,
           "responses_hash": "<hash>", "cell_answers_hash": "<hash>", "auto_reviews": [],
           "reviews": [{"id": "c5e00000-0000-0000-0000-000000000001", "verdict": "Humano",
             "chosen_response_id": "c5d10000-0000-0000-0000-000000000001", "comment": null, "response_snapshot": null}]}},
       "current_context": "<igual a context>"},
      {"id": "<id>", "project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000002",
       "field_name": "q", "decision": "researchers_correct", "resolved_at": "<resolved_at>",
       "resolved_by": "c5a00000-0000-0000-0000-000000000001", "note": "Conferido", "approved_value": "Veredito",
       "context": {"project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000002",
         "field_name": "q", "round_id": "<round>", "automation_mode": "compare_llm",
         "field_definition": {"id": "c5f10000-0000-4000-8000-000000000001", "name": "q", "type": "text",
           "description": "Pergunta", "options": null, "hash": "c5c5c5c5c5c5"},
         "llm_response_id": "c5d00000-0000-0000-0000-000000000002", "human_response_id": "c5d10000-0000-0000-0000-000000000002",
         "llm_value": {"present": true, "value": "LLM"}, "human_value": {"present": true, "value": "Humano"},
         "source": {"kind": "comparacao", "id": "c5e00000-0000-0000-0000-000000000002", "verdict": "Humano",
           "chosen_response_id": "c5d10000-0000-0000-0000-000000000002", "response_snapshot": null, "comment": null,
           "responses_hash": "<hash>", "cell_answers_hash": "<hash>", "auto_reviews": [],
           "reviews": [{"id": "c5e00000-0000-0000-0000-000000000002", "verdict": "Humano",
             "chosen_response_id": "c5d10000-0000-0000-0000-000000000002", "comment": null, "response_snapshot": null}]}},
       "current_context": "<igual a context>"},
      {"id": "<id>", "project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000003",
       "field_name": "q", "decision": "both_correct", "resolved_at": "<resolved_at>",
       "resolved_by": "c5a00000-0000-0000-0000-000000000001", "note": "Conferido", "approved_value": null,
       "context": {"project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000003",
         "field_name": "q", "round_id": "<round>", "automation_mode": "compare_llm",
         "field_definition": {"id": "c5f10000-0000-4000-8000-000000000001", "name": "q", "type": "text",
           "description": "Pergunta", "options": null, "hash": "c5c5c5c5c5c5"},
         "llm_response_id": "c5d00000-0000-0000-0000-000000000003", "human_response_id": "c5d10000-0000-0000-0000-000000000003",
         "llm_value": {"present": true, "value": "LLM"}, "human_value": {"present": true, "value": "Humano"},
         "source": {"kind": "comparacao", "id": "c5e00000-0000-0000-0000-000000000003", "verdict": "Humano",
           "chosen_response_id": "c5d10000-0000-0000-0000-000000000003", "response_snapshot": null, "comment": null,
           "responses_hash": "<hash>", "cell_answers_hash": "<hash>", "auto_reviews": [],
           "reviews": [{"id": "c5e00000-0000-0000-0000-000000000003", "verdict": "Humano",
             "chosen_response_id": "c5d10000-0000-0000-0000-000000000003", "comment": null, "response_snapshot": null}]}},
       "current_context": "<igual a context>"},
      {"id": "<id>", "project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000004",
       "field_name": "q", "decision": "all_wrong", "resolved_at": "<resolved_at>",
       "resolved_by": "c5a00000-0000-0000-0000-000000000001", "note": "Conferido", "approved_value": "Terceira",
       "context": {"project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000004",
         "field_name": "q", "round_id": "<round>", "automation_mode": "compare_llm",
         "field_definition": {"id": "c5f10000-0000-4000-8000-000000000001", "name": "q", "type": "text",
           "description": "Pergunta", "options": null, "hash": "c5c5c5c5c5c5"},
         "llm_response_id": "c5d00000-0000-0000-0000-000000000004", "human_response_id": "c5d10000-0000-0000-0000-000000000004",
         "llm_value": {"present": true, "value": "LLM"}, "human_value": {"present": true, "value": "Humano"},
         "source": {"kind": "comparacao", "id": "c5e00000-0000-0000-0000-000000000004", "verdict": "Humano",
           "chosen_response_id": "c5d10000-0000-0000-0000-000000000004", "response_snapshot": null, "comment": null,
           "responses_hash": "<hash>", "cell_answers_hash": "<hash>", "auto_reviews": [],
           "reviews": [{"id": "c5e00000-0000-0000-0000-000000000004", "verdict": "Humano",
             "chosen_response_id": "c5d10000-0000-0000-0000-000000000004", "comment": null, "response_snapshot": null}]}},
       "current_context": "<igual a context>"},
      {"id": "<id>", "project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000005",
       "field_name": "q", "decision": "discussion", "resolved_at": "<resolved_at>",
       "resolved_by": "c5a00000-0000-0000-0000-000000000001", "note": "Conferido", "approved_value": null,
       "context": {"project_id": "c5b00000-0000-0000-0000-000000000001", "document_id": "c5c00000-0000-0000-0000-000000000005",
         "field_name": "q", "round_id": "<round>", "automation_mode": "compare_llm",
         "field_definition": {"id": "c5f10000-0000-4000-8000-000000000001", "name": "q", "type": "text",
           "description": "Pergunta", "options": null, "hash": "c5c5c5c5c5c5"},
         "llm_response_id": "c5d00000-0000-0000-0000-000000000005", "human_response_id": "c5d10000-0000-0000-0000-000000000005",
         "llm_value": {"present": true, "value": "LLM"}, "human_value": {"present": true, "value": "Humano"},
         "source": {"kind": "comparacao", "id": "c5e00000-0000-0000-0000-000000000005", "verdict": "Humano",
           "chosen_response_id": "c5d10000-0000-0000-0000-000000000005", "response_snapshot": null, "comment": null,
           "responses_hash": "<hash>", "cell_answers_hash": "<hash>", "auto_reviews": [],
           "reviews": [{"id": "c5e00000-0000-0000-0000-000000000005", "verdict": "Humano",
             "chosen_response_id": "c5d10000-0000-0000-0000-000000000005", "comment": null, "response_snapshot": null}]}},
       "current_context": "<igual a context>"}
    ],
    "value_equivalences": [
      {"id": "<id>", "field_name": "q", "field_hash": "c5c5c5c5c5c5", "value_a": "N/A", "value_b": "NI",
       "reviewer_id": "c5a00000-0000-0000-0000-000000000001"}
    ]
  }
}
$fixture$, false);

-- Fixture de banco a partir de "input". A coordenadora é a criadora do projeto
-- (decide e marca "="); a resposta humana é de outra pessoa. A célula do "="
-- tem valores próprios: a equivalência vale para o projeto inteiro, e com os
-- mesmos valores ela também tiraria o erro medido das células decididas.
INSERT INTO auth.users (id, email) VALUES
  ('c5a00000-0000-0000-0000-000000000001', 'cycle-coordinator@example.test'),
  ('c5a00000-0000-0000-0000-000000000002', 'cycle-coder@example.test');
INSERT INTO public.clerk_user_mapping (clerk_user_id, supabase_user_id, access_sync_version)
  SELECT id::TEXT, id, 1 FROM auth.users WHERE id::TEXT LIKE 'c5a00000-%';

DO $$
DECLARE
  f JSONB := current_setting('test.cycle_fixture')::JSONB->'input';
  cell JSONB;
BEGIN
  INSERT INTO public.projects (id, name, created_by, automation_mode, pydantic_fields)
  VALUES ((f->>'project_id')::UUID, 'Ciclo da fila', (f->>'coordinator_id')::UUID, 'compare_llm', f->'fields');
  FOR cell IN SELECT * FROM jsonb_array_elements(f->'cells') LOOP
    INSERT INTO public.documents (id, project_id, title, text)
    VALUES ((cell->>'document_id')::UUID, (f->>'project_id')::UUID, 'Documento', 'Texto');
    INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
      ((cell->>'llm_response_id')::UUID, (f->>'project_id')::UUID, (cell->>'document_id')::UUID, NULL, 'llm',
       jsonb_build_object('q', cell->'llm_answer')),
      ((cell->>'human_response_id')::UUID, (f->>'project_id')::UUID, (cell->>'document_id')::UUID,
       (f->>'coder_id')::UUID, 'humano', jsonb_build_object('q', cell->'human_answer'));
    INSERT INTO public.reviews (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
    VALUES ((cell->>'review_id')::UUID, (f->>'project_id')::UUID, (cell->>'document_id')::UUID, 'q',
      (f->>'coordinator_id')::UUID, cell->>'human_answer', (cell->>'human_response_id')::UUID);
  END LOOP;
END $$;

-- As ações do card, pela identidade da coordenadora, como a página as chama
-- (actions/stats.ts e actions/equivalences.ts).
SELECT set_config('request.jwt.claims',
  '{"sub":"c5a00000-0000-0000-0000-000000000001","supabase_uid":"c5a00000-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  f JSONB := current_setting('test.cycle_fixture')::JSONB->'input';
  cell JSONB;
  c JSONB;
BEGIN
  FOR cell IN SELECT * FROM jsonb_array_elements(f->'cells') LOOP
    IF cell->>'action' = 'equivalent' THEN
      PERFORM public.record_value_equivalences(jsonb_build_array(jsonb_build_object(
        'project_id', f->>'project_id', 'document_id', cell->>'document_id', 'field_name', 'q',
        'response_a_id', cell->>'human_response_id', 'response_b_id', cell->>'llm_response_id',
        'reviewer_id', f->>'coordinator_id', 'source', 'llm_insights')));
    ELSE
      c := public.llm_error_context((f->>'project_id')::UUID, (cell->>'document_id')::UUID, 'q',
        (cell->>'llm_response_id')::UUID, (cell->>'human_response_id')::UUID, 'comparacao', (cell->>'review_id')::UUID);
      IF c IS NULL THEN RAISE EXCEPTION 'FALHOU: sem contexto para %', cell->>'action'; END IF;
      PERFORM public.set_error_resolution((f->>'project_id')::UUID, (cell->>'document_id')::UUID, 'q',
        cell->>'action', c, NULL, NULL, 'Conferido', NULLIF(cell->'value', 'null'::JSONB));
    END IF;
  END LOOP;
END $$;

-- A carga seguinte, ainda como a coordenadora (RLS de leitura incluída).
DO $$
DECLARE
  f JSONB := current_setting('test.cycle_fixture')::JSONB;
  project UUID := (f->'input'->>'project_id')::UUID;
  round UUID;
  item RECORD;
  normalized JSONB;
  resolutions JSONB;
  equivalences JSONB;
BEGIN
  SELECT current_round_id INTO round FROM public.projects WHERE id = project;

  -- Cru: logo depois da gravação, o contexto corrente é o gravado, byte a byte.
  FOR item IN SELECT * FROM public.read_error_resolutions(project) LOOP
    IF item.current_context IS DISTINCT FROM item.context THEN
      RAISE EXCEPTION 'FALHOU: % lida como fontes alteradas logo após gravar: context=% current=%',
        item.decision, item.context, item.current_context;
    END IF;
    IF item.context->>'round_id' IS DISTINCT FROM round::TEXT
      OR COALESCE(item.context->'source'->>'responses_hash', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(item.context->'source'->>'cell_answers_hash', '') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'FALHOU: valores opacos fora do formato em %: %', item.decision, item.context;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', '<id>', 'project_id', r.project_id, 'document_id', r.document_id, 'field_name', r.field_name,
      'decision', r.decision, 'resolved_at', '<resolved_at>', 'resolved_by', r.resolved_by,
      'note', r.note, 'approved_value', r.approved_value,
      'context', jsonb_set(jsonb_set(jsonb_set(r.context, '{round_id}', '"<round>"'),
        '{source,responses_hash}', '"<hash>"'), '{source,cell_answers_hash}', '"<hash>"'),
      'current_context', '<igual a context>') ORDER BY r.document_id), '[]')
  INTO resolutions
  FROM public.read_error_resolutions(project) AS r;

  -- As colunas de VALUE_EQUIVALENCE_SELECT (src/lib/equivalence.ts).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', '<id>', 'field_name', e.field_name, 'field_hash', e.field_hash,
      'value_a', e.value_a, 'value_b', e.value_b, 'reviewer_id', e.reviewer_id) ORDER BY e.field_name), '[]')
  INTO equivalences
  FROM public.value_equivalences AS e WHERE e.project_id = project;

  normalized := jsonb_build_object('read_error_resolutions', resolutions, 'value_equivalences', equivalences);
  IF normalized IS DISTINCT FROM f->'expected' THEN
    RAISE EXCEPTION 'FALHOU: o banco devolveu outro formato. Normalizado: %', normalized;
  END IF;
  RAISE NOTICE 'OK: ciclo da fila do LLM Insights devolve o formato do fixture';
END $$;
RESET ROLE;

ROLLBACK;
