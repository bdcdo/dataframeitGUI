-- Braços faltantes nas policies (auditoria do #178): em todos os casos a UI
-- já oferece o fluxo ao papel e a RLS filtrava em silêncio (UPDATE/DELETE →
-- 0 linhas, error=null) ou negava com 42501. Quatro consertos por DROP/CREATE,
-- sem mudar a semântica para quem já passava.

-- 1) rounds: única policy coordinator-manage do conjunto sem is_master().
--    Master usando a UI de rodadas em projeto alheio: INSERT → 42501,
--    UPDATE/DELETE → silent no-op. O texto antigo (coordenador-membro ∪
--    criador via subquery) equivale a auth_user_coordinator_or_creator_project_ids().
DROP POLICY "Coordinators manage rounds" ON rounds;
CREATE POLICY "Coordinators manage rounds" ON rounds
  FOR ALL
  USING (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR is_master()
  )
  WITH CHECK (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR is_master()
  );

-- 2) project_members: "Coordinators manage members" não tinha braço de
--    criador (criador não-membro só tinha INSERT via "Creator inserts
--    members"): changeRole/setCanResolve viravam silent no-op com toast de
--    sucesso. A policy "Creator inserts members" fica redundante mas é
--    mantida (risco zero).
DROP POLICY "Coordinators manage members" ON project_members;
CREATE POLICY "Coordinators manage members" ON project_members
  FOR ALL
  USING (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR is_master()
  )
  WITH CHECK (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR is_master()
  );

-- 3) note_resolutions: alinhar com difficulty/error_resolutions, que já
--    incluem resolver (can_resolve) e master. Hoje resolveNote dá 42501 para
--    resolver/master e reopenNote é silent no-op para eles.
DROP POLICY "Coordinators insert note_resolutions" ON note_resolutions;
DROP POLICY "Coordinators delete note_resolutions" ON note_resolutions;
CREATE POLICY "Coordinators or resolvers insert note_resolutions" ON note_resolutions
  FOR INSERT
  WITH CHECK (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR project_id IN (SELECT auth_user_resolver_project_ids())
    OR is_master()
  );
CREATE POLICY "Coordinators or resolvers delete note_resolutions" ON note_resolutions
  FOR DELETE
  USING (
    project_id IN (SELECT auth_user_coordinator_or_creator_project_ids())
    OR project_id IN (SELECT auth_user_resolver_project_ids())
    OR is_master()
  );

-- 4) project_comments: delete do comentário automático de ambiguidade era
--    membro-only — master (e criador não-membro, e contas-alias da spec 002)
--    mudando veredito de 'ambiguo' deixava a pendência órfã (silent no-op).
--    auth_user_accessible_project_ids = membro ∪ criador ∪ alias.
DROP POLICY "Members can delete ambiguity comments" ON project_comments;
CREATE POLICY "Members can delete ambiguity comments" ON project_comments
  FOR DELETE
  USING (
    kind = 'ambiguity'
    AND (
      project_id IN (SELECT auth_user_accessible_project_ids())
      OR is_master()
    )
  );
