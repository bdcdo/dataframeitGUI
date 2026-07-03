-- Corrige final_answers para de fato checar RLS pelo usuario que consulta,
-- nao pelo dono da view (achado da revisao da PR #408; lottery_doc_stats
-- ja nasce com a mesma clausula na propria migration de criacao, ainda nao
-- mergeada quando este fix foi escrito, entao nao precisa de ALTER aqui).
--
-- security_invoker so e opt-in desde o PG15 (major_version = 15 neste
-- projeto) -- SEM essa opcao, uma view checa privilegios/RLS das tabelas
-- base com o DONO da view (o role usado por migrations do Supabase,
-- tipicamente com BYPASSRLS), nao com quem executa a query. O comentario
-- original de final_answers ("SECURITY INVOKER (default)") estava errado:
-- nao ha default de invoker em Postgres. Sem o fix, qualquer usuario
-- authenticated podia, em tese, ler a view para qualquer project_id
-- arbitrario -- o .eq("project_id", ...) que o app aplica e so um filtro de
-- aplicacao, nao uma barreira de autorizacao.

ALTER VIEW final_answers SET (security_invoker = true);
