-- Recarimbo de `reviews.round_id` pela coluna mencionada, nao pelo valor (#733).
--
-- A migration anterior (20260918120000) recarimbava no UPDATE quando
-- `verdict`, `chosen_response_id` ou `response_snapshot` mudavam de VALOR. A
-- revisao do PR achou o caso em que isso falha: rodada nova aberta para
-- recodificar parte do corpus, documento nao recodificado, revisor rearbitra
-- escolhendo a mesma resposta com o mesmo veredito. O upsert de `submitVerdict`
-- manda um payload byte a byte igual ao da linha, o `IS DISTINCT FROM` nao ve
-- diferenca, a review fica na rodada anterior e some da fila, do Gabarito e do
-- export; votar de novo produz o mesmo payload, e o estado nao tem conserto
-- pela UI. E a familia "codificacao nao salva" de docs/VERIFICATION.md.
--
-- O Postgres oferece o discriminador certo: `BEFORE UPDATE OF <colunas>`
-- dispara quando a coluna esta no SET, mude ou nao de valor. O upsert do
-- PostgREST sempre poe as colunas do payload no SET, entao toda rearbitracao
-- recarimba; `resolved_at`/`resolved_by`/`comment` (manutencao) e `reviewer_id`
-- (unificacao de contas) ficam fora da lista e nao movem a review.
--
-- Duas outras correcoes da mesma revisao, no mesmo gesto: `round_id` passa a
-- ser imutavel para o cliente no UPDATE, como `responses` (23514), porque a
-- policy `Reviewers manage reviews` deixaria um PATCH mover a propria review
-- para outra rodada do projeto; e o INSERT volta a usar `fill_current_round_id`,
-- a funcao das tabelas irmas, cujo corpo o ramo INSERT anterior duplicava.
--
-- Os gatilhos BEFORE do mesmo evento disparam em ordem alfabetica de nome:
-- `reviews_round_immutable` ve o payload do cliente antes de
-- `reviews_stamp_round` recarimbar. Os nomes carregam essa ordem de proposito.

BEGIN;

DROP TRIGGER reviews_stamp_round ON public.reviews;
DROP FUNCTION public.stamp_review_round();

CREATE TRIGGER reviews_fill_current_round
BEFORE INSERT ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.fill_current_round_id();

CREATE FUNCTION public.enforce_review_round_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.round_id IS DISTINCT FROM OLD.round_id THEN
    RAISE EXCEPTION 'reviews.round_id e carimbada pelo servidor e nao pode ser alterada pelo cliente'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.stamp_review_round()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  SELECT current_round_id INTO NEW.round_id
  FROM public.projects WHERE id = NEW.project_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_review_round_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.stamp_review_round()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reviews_round_immutable
BEFORE UPDATE ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.enforce_review_round_immutable();

CREATE TRIGGER reviews_stamp_round
BEFORE UPDATE OF verdict, chosen_response_id, response_snapshot ON public.reviews
FOR EACH ROW EXECUTE FUNCTION public.stamp_review_round();

COMMIT;
