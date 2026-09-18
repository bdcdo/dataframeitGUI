-- reviews.round_id: a arbitragem passa a pertencer a uma rodada (#733).
--
-- Ate aqui `reviews` era a unica tabela de escrita do fluxo sem rodada:
-- `responses`, `assignments`, `assignment_batches` e `llm_runs` ganharam
-- `round_id` no #642 e no #690, e a arbitragem ficou de fora. A consequencia
-- apareceu na fila LLM Insights, no export e no Gabarito: os tres consumiam a
-- review mais recente da celula, de qualquer rodada, e mediam o LLM da rodada
-- corrente contra vereditos dados sobre respostas de rodadas anteriores. Num
-- projeto que trocou de formulario entre rodadas, o veredito antigo pode nem
-- ser opcao do formulario atual.
--
-- Backfill em tres passos, do mais confiavel ao menos:
--   (a) a rodada da resposta escolhida (`chosen_response_id`), quando ha uma;
--   (b) senao, a rodada do projeto mais recente criada ate `reviews.created_at`;
--   (c) senao, a rodada mais antiga do projeto: review anterior a qualquer
--       rodada pertence a "Rodada inicial", que o #642 criou para representar
--       retroativamente todo o historico.
-- (a) vem antes de (b) porque o upsert de rearbitracao nao altera
-- `created_at`: uma review inserida numa rodada e rearbitrada na seguinte fica
-- com a data da primeira e a resposta da segunda. Medido em 2026-09-18 no
-- projeto multi-rodada de producao, toda discordancia entre (a) e (b) era desse
-- tipo (resposta de rodada posterior a data), nenhuma no sentido contrario.
--
-- Escritas novas: trigger `stamp_review_round`. No INSERT preenche a rodada
-- corrente quando o payload nao traz `round_id` (mesmo contrato de
-- `fill_current_round_id`: valor explicito nunca e sobrescrito). No UPDATE
-- recarimba a rodada corrente quando o conteudo da arbitragem muda (`verdict`,
-- `chosen_response_id`, `response_snapshot`) e deixa a rodada quieta quando so
-- `resolved_at`/`resolved_by`/`comment` mudam. O UPDATE importa porque
-- `submitVerdict` e `confirmEquivalentVerdict` gravam por upsert em
-- UNIQUE(project_id, document_id, field_name, reviewer_id), sem rodada na
-- chave: rearbitrar na rodada nova atualiza a linha antiga, e sem o recarimbo
-- ela continuaria carimbada com a rodada anterior e fora da fila. A isencao do
-- update de manutencao e a licao de 20260820170000: sem ela, resolver o
-- comentario de uma review de rodada passada a moveria de rodada.
--
-- FK composta `(project_id, round_id) -> rounds(project_id, id)` como nas
-- tabelas irmas: a simples aceitaria review de um projeto carimbada com rodada
-- de outro. `project_id` vira NOT NULL no mesmo gesto, porque a FK composta
-- com MATCH SIMPLE nao checa linha com `project_id` nulo e a trigger nao teria
-- de onde ler a rodada corrente; o preflight garante que nao ha linha assim.
--
-- O que muda para o leitor: fila, export e Gabarito passam a considerar so
-- reviews da rodada corrente (frontend, mesmo PR). Decisao ja gravada em
-- `error_resolutions` sobre celula de rodada antiga continua valendo:
-- `llm_error_context` le a review por id e nao filtra rodada.

BEGIN;

ALTER TABLE public.reviews
  ADD COLUMN round_id uuid;

-- Preflight fail-fast, na idiomatica de 20260811120000: o backfill abaixo
-- precisa do projeto de cada review e de ao menos uma rodada por projeto.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reviews WHERE project_id IS NULL) THEN
    RAISE EXCEPTION 'reviews round_id: review sem project_id; a FK composta nao a cobriria e a trigger nao teria de onde ler a rodada';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reviews AS review
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rounds AS round
      WHERE round.project_id = review.project_id
    )
  ) THEN
    RAISE EXCEPTION 'reviews round_id: projeto com review e sem rodada; crie a rodada antes de migrar';
  END IF;
END $$;

-- (a) A rodada da resposta escolhida. `responses.round_id` e NOT NULL desde o
-- #642, entao toda review com escolha sai daqui carimbada.
UPDATE public.reviews AS review
SET round_id = response.round_id
FROM public.responses AS response
WHERE response.id = review.chosen_response_id
  AND response.project_id = review.project_id;

-- (b) Sem escolha (veredito "ambiguo", "pular"): a rodada mais recente do
-- projeto que ja existia quando a review foi criada.
UPDATE public.reviews AS review
SET round_id = (
  SELECT round.id
  FROM public.rounds AS round
  WHERE round.project_id = review.project_id
    AND round.created_at <= review.created_at
  ORDER BY round.created_at DESC
  LIMIT 1
)
WHERE review.round_id IS NULL;

-- (c) Review anterior a toda rodada do projeto: a mais antiga.
UPDATE public.reviews AS review
SET round_id = (
  SELECT round.id
  FROM public.rounds AS round
  WHERE round.project_id = review.project_id
  ORDER BY round.created_at ASC
  LIMIT 1
)
WHERE review.round_id IS NULL;

-- Sem `ON DELETE` (NO ACTION) de proposito, como em llm_runs: `reviews` e
-- `rounds` ja cascateiam de `projects`, e a checagem NO ACTION roda no fim do
-- statement, quando o cascade ja removeu a review. RESTRICT quebraria a
-- exclusao de projeto.
ALTER TABLE public.reviews
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN round_id SET NOT NULL,
  ADD CONSTRAINT reviews_project_round_fk
    FOREIGN KEY (project_id, round_id)
    REFERENCES public.rounds(project_id, id);

-- Os tres consumidores filtram por (project_id, round_id).
CREATE INDEX idx_reviews_project_round
  ON public.reviews(project_id, round_id);

CREATE FUNCTION public.stamp_review_round()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.round_id IS NULL THEN
      SELECT current_round_id INTO NEW.round_id
      FROM public.projects WHERE id = NEW.project_id;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: so o conteudo da arbitragem move a review de rodada. Comentario e
  -- resolucao de comentario sao manutencao e nao tocam no carimbo.
  IF NEW.verdict IS DISTINCT FROM OLD.verdict
     OR NEW.chosen_response_id IS DISTINCT FROM OLD.chosen_response_id
     OR NEW.response_snapshot IS DISTINCT FROM OLD.response_snapshot THEN
    SELECT current_round_id INTO NEW.round_id
    FROM public.projects WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Funcao de trigger nao e RPC: revogar de PUBLIC e o que fecha de fato
-- (20260724120000). `rls_audit.test.sql` cobra isso para toda funcao de trigger.
REVOKE ALL ON FUNCTION public.stamp_review_round()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reviews_stamp_round
BEFORE INSERT OR UPDATE ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.stamp_review_round();

COMMIT;
