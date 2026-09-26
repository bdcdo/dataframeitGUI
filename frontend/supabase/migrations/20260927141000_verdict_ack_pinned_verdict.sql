-- O reconhecimento de veredito fica preso ao veredito reconhecido (#758).
--
-- `verdict_acknowledgments` guardava so `review_id`. A rearbitragem de
-- `submitVerdict` e um upsert na chave (projeto, documento, campo, revisor), que
-- reaproveita o `reviews.id`: um veredito novo herdava o "Aceitar correção" ou
-- a dúvida dada ao veredito anterior, e Meus vereditos mostrava o pesquisador
-- ciente de um veredito que ele nunca viu.
--
-- `acknowledged_verdict` guarda o texto do veredito reconhecido. O
-- reconhecimento vale enquanto ele e o `reviews.verdict` atual; mudou o
-- veredito, o item volta a pendente em Meus vereditos e a dúvida sai de
-- Comentarios. A copia TypeScript da regra e `acknowledgmentIsCurrent`
-- (frontend/src/lib/reviews/verdict-acknowledgment.ts).
--
-- O cliente manda o veredito que a tela mostrou, e o gatilho so aceita gravar
-- o reconhecimento (INSERT, ou UPDATE que toca `review_id`, `status`, `comment`
-- ou o proprio `acknowledged_verdict`) quando ele e o veredito atual da review.
-- Assim o servidor nao confia no cliente nem carimba por conta propria um
-- veredito que a pessoa nao viu: a review mudou entre a tela e o clique, 40001
-- e "recarregue". A manutencao do coordenador (`resolved_at`, `resolved_by`) e a
-- unificacao de contas (`respondent_id`) nao tocam essas colunas e nao passam
-- pelo gatilho.
--
-- Backfill: o veredito atual da review, para todo reconhecimento existente.
-- Medido em producao em 2026-09-26, so leitura: 163 reconhecimentos (116
-- aceites, 47 duvidas, 15 delas abertas) sobre 97 reviews de 2 projetos. Nenhum
-- aponta, por escolha ou snapshot, para resposta criada depois dele, que seria
-- a prova de rearbitragem posterior; o unico sinal de mudanca, a rodada da
-- review criada depois do reconhecimento (136 casos), e todo da "Rodada
-- inicial" retroativa de 2026-07-31, que o backfill de `reviews.round_id`
-- carimbou em reviews anteriores a ela. Sem prova de mudanca, invalidar os 163
-- obrigaria a reconhecer de novo vereditos que ninguem mudou; carimbar o
-- veredito atual os mantem validos e passa a detectar toda rearbitragem daqui
-- em diante. Um reconhecimento de veredito que ja tivesse mudado antes desta
-- migration (sem registro que o mostre) fica valendo, e esse e o custo aceito.

BEGIN;

ALTER TABLE public.verdict_acknowledgments
  ADD COLUMN acknowledged_verdict TEXT;

UPDATE public.verdict_acknowledgments AS ack
SET acknowledged_verdict = review.verdict
FROM public.reviews AS review
WHERE review.id = ack.review_id;

DO $$
DECLARE
  v_total BIGINT;
BEGIN
  SELECT pg_catalog.count(*) INTO v_total FROM public.verdict_acknowledgments;
  RAISE NOTICE 'verdict_acknowledgments: % reconhecimento(s) carimbado(s) com o veredito atual da review', v_total;
END $$;

ALTER TABLE public.verdict_acknowledgments
  ALTER COLUMN acknowledged_verdict SET NOT NULL;

-- INVOKER de proposito: le a review com a RLS de quem grava. Como DEFINER, o
-- 40001 de veredito errado sobre review de outro projeto seria um oraculo do
-- texto do veredito (acertou, o erro passava a ser o 42501 da policy). Review
-- invisivel segue adiante, e a policy de INSERT/UPDATE recusa.
CREATE FUNCTION public.enforce_verdict_acknowledgment_current()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_verdict TEXT;
BEGIN
  SELECT review.verdict INTO v_verdict FROM public.reviews AS review WHERE review.id = NEW.review_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.acknowledged_verdict IS NULL OR NEW.acknowledged_verdict IS DISTINCT FROM v_verdict THEN
    RAISE EXCEPTION 'O veredito mudou desde que a página carregou. Recarregue antes de responder a ele.'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

-- Funcao de trigger nao e RPC (20260724120000, `rls_audit.test.sql`).
REVOKE ALL ON FUNCTION public.enforce_verdict_acknowledgment_current()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER verdict_acknowledgments_pin_verdict
BEFORE INSERT OR UPDATE OF review_id, status, comment, acknowledged_verdict ON public.verdict_acknowledgments
FOR EACH ROW EXECUTE FUNCTION public.enforce_verdict_acknowledgment_current();

COMMIT;
