-- Fecha o acesso de `anon` às views de `public` (continuação da #134).
--
-- A auditoria do #601 rodou contra o catálogo local e passou; rodada contra
-- PRODUÇÃO, acusou o que o ambiente local não modela — o remoto concede DML por
-- default no schema public, o local não. Medido em 24/07/2026:
--
--   lottery_doc_stats  ->  anon=arwdDxtm   (inclui SELECT)
--   final_answers      ->  anon=awdDxtm    (sem SELECT, mas com INSERT/UPDATE/DELETE)
--
-- O `final_answers` é o caso instrutivo: alguém já revogou o SELECT em algum
-- momento e deixou os bits de escrita para trás. Uma asserção que olhasse só
-- SELECT — como a primeira versão desta auditoria — daria o arquivo por limpo.
--
-- A exposição efetiva era pequena, porque as quatro views têm
-- `security_invoker = true` e uma leitura de `anon` esbarra na RLS das tabelas
-- de base. Isso é o motivo de a correção ser barata, não de ela ser dispensável:
-- a garantia não deve depender de duas camadas estarem simultaneamente certas.
--
-- O REVOKE é varrido sobre TODAS as views de `public`, e não sobre uma lista de
-- nomes, para que uma view futura nasça fechada mesmo que ninguém lembre de
-- editar esta migration. `anon` não tem caso de uso em nenhuma delas: toda
-- leitura do produto passa por sessão autenticada.
DO $$
DECLARE
  view_name text;
BEGIN
  FOR view_name IN
    SELECT relation.oid::regclass::text
    FROM pg_class AS relation
    WHERE relation.relnamespace = 'public'::regnamespace
      AND relation.relkind = 'v'
    ORDER BY 1
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM anon', view_name);
  END LOOP;
END;
$$;

-- Default privileges: sem isto, a próxima view criada pelo owner volta a nascer
-- com os grants que o bootstrap do Supabase concede a `anon`, e a varredura
-- acima vira um reparo que precisa ser repetido a cada view nova.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
