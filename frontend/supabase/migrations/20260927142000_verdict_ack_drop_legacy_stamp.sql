-- Tira a compatibilidade com o frontend anterior do gatilho de reconhecimento
-- de veredito (20260927141000).
--
-- O gatilho carimbava o veredito atual quando `acknowledged_verdict` chegava
-- NULL, ou, num UPDATE, igual ao valor gravado, que era como chegava o upsert
-- do frontend que nao mandava a coluna. Esse frontend saiu do ar, e
-- `acknowledgeVerdict` (actions/verdicts.ts), o unico escritor do app, sempre
-- manda o veredito que a tela mostrou. Com o carimbo, um UPDATE de `status` ou
-- `comment` sem a coluna, sobre review rearbitrada, passava o reconhecimento
-- para um veredito que o pesquisador nunca viu.
--
-- Agora vale so a regra: o valor gravado tem de ser o veredito atual da
-- review, senao 40001. NULL nao e o veredito atual, e o UPDATE que nao toca a
-- coluna so passa se o veredito reconhecido continua sendo o atual.
-- A coluna ja e NOT NULL desde 20260927141000; CREATE OR REPLACE mantem o
-- REVOKE daquela migration.

CREATE OR REPLACE FUNCTION public.enforce_verdict_acknowledgment_current()
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
  IF NEW.acknowledged_verdict IS DISTINCT FROM v_verdict THEN
    RAISE EXCEPTION 'O veredito mudou desde que a página carregou. Recarregue antes de responder a ele.'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
