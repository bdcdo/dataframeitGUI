-- Revoga SELECT de anon em final_answers. A migration original
-- (20260513000003_final_answers_view.sql) ja foi corrigida para nao
-- conceder a anon, mas o GRANT ja foi aplicado no remoto — esta migration
-- limpa isso e e idempotente (REVOKE de algo nao concedido e no-op).
--
-- Motivo: app autenticado via Clerk nao tem fluxo anon; reduzir superficie
-- caso futura migration regrida RLS de responses/projects.

REVOKE SELECT ON final_answers FROM anon;
