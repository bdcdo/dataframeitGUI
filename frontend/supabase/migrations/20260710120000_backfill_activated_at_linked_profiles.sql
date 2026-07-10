-- Backfill pontual (follow-up do PR #418): o #418 removeu de getAuthUser() o
-- fallback que ativava (activated_at) um profile pendente durante o render
-- (decisao D3 -- nenhuma escrita de vinculo no render path). A ativacao passou a
-- viver so no webhook user.created (com retry do Svix) e na acao completeAccess.
-- Perfis que, antes deste PR, ja tinham vinculo Clerk real mas ficaram com
-- activated_at nulo (webhook de ativacao perdido/parcial) eram consertados por
-- aquele fallback; sem ele, permaneceriam eternamente com o selo "pendente" para
-- o coordenador. Esta migration os ativa uma vez, alinhando o dado ao estado real.
--
-- Escopo preciso: so perfis COM clerk_user_mapping (vinculo real = ja entraram).
-- Pre-registrados nunca-logados (sem mapping) seguem pendentes, como devem.
-- Idempotente: o filtro `activated_at IS NULL` nao reativa nem sobrescreve o
-- instante original de quem ja esta ativo. Usa created_at (mesmo criterio da
-- migration 20260611120000) por ser o proxy mais fiel de "quando entrou".

UPDATE profiles p
SET activated_at = p.created_at
WHERE p.activated_at IS NULL
  AND EXISTS (
    SELECT 1 FROM clerk_user_mapping m
    WHERE m.supabase_user_id = p.id
  );
