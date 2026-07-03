-- Estado "em revisão de escopo" para documentos + toggle do recurso por projeto.
--
-- Contexto: pesquisador sinaliza documento fora de escopo (project_comments
-- kind='exclusion_request'), mas até o coordenador aprovar o doc continuava
-- aparecendo em todas as filas (codificação, browse, Comparação, LLM). Agora
-- o pedido pendente marca documents.exclusion_pending_at e as leituras
-- filtram o doc imediatamente; o soft delete (excluded_at) segue ocorrendo
-- só na aprovação, e a rejeição/cancelamento devolve o doc às filas.
--
-- Por que coluna denormalizada + trigger (e não anti-join nas queries):
-- PostgREST não expressa NOT EXISTS; os ~14 call sites que já filtram
-- excluded_at IS NULL ganham uma linha no mesmo padrão. E por que trigger
-- SECURITY DEFINER (e não server action): a RLS de documents é
-- coordinator-only para escrita — o pesquisador não pode dar UPDATE. O
-- trigger dispara pelas escritas que ele JÁ pode fazer em project_comments e
-- grava um valor derivado (recompute idempotente), impossível de forjar.
-- Mesmo padrão de enforce_resolver_column_guard (20260527130000).
--
-- Migration idempotente (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS) para
-- sobreviver a reaplicação via `supabase db push`.

-- 1. Coluna de estado pendente (NULL = fora de revisão de escopo).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS exclusion_pending_at TIMESTAMPTZ NULL;

-- 2. Índice parcial para o novo caminho quente (docs ativos E fora de
--    revisão). idx_documents_active (só excluded_at) permanece: a config de
--    documentos do coordenador continua consultando apenas por excluded_at.
CREATE INDEX IF NOT EXISTS idx_documents_in_scope
  ON documents(project_id)
  WHERE excluded_at IS NULL AND exclusion_pending_at IS NULL;

-- 3. Recompute idempotente: o estado do doc é derivado dos pedidos
--    pendentes. min(created_at) (ou NULL) reconverge em qualquer
--    INSERT/UPDATE/DELETE de pedido — sem lógica de contador, sem bug de
--    "limpar cedo demais" quando há pedidos de mais de um autor.
CREATE OR REPLACE FUNCTION public.recompute_exclusion_pending()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  doc_id UUID;
  req_kind TEXT;
BEGIN
  -- Em DELETE só OLD existe; referenciar NEW em plpgsql lançaria erro.
  IF TG_OP = 'DELETE' THEN
    req_kind := OLD.kind;
    doc_id := OLD.document_id;
  ELSE
    req_kind := NEW.kind;
    doc_id := NEW.document_id;
  END IF;

  -- Só pedidos de exclusão interessam.
  IF req_kind <> 'exclusion_request' THEN
    RETURN NULL;
  END IF;

  -- Pedido órfão (document_id ON DELETE SET NULL): nada a recomputar.
  IF doc_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.documents d
  SET exclusion_pending_at = (
    SELECT min(pc.created_at)
    FROM public.project_comments pc
    WHERE pc.document_id = doc_id
      AND pc.kind = 'exclusion_request'
      AND pc.resolved_at IS NULL
      AND pc.rejected_at IS NULL
  )
  WHERE d.id = doc_id;

  RETURN NULL;  -- trigger AFTER: valor de retorno é ignorado
END;
$$;

DROP TRIGGER IF EXISTS maintain_exclusion_pending ON project_comments;
CREATE TRIGGER maintain_exclusion_pending
  AFTER INSERT OR DELETE OR UPDATE OF resolved_at, rejected_at
  ON project_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.recompute_exclusion_pending();

-- 4. Autor pode cancelar ("desfazer") o próprio pedido enquanto pendente.
--    DELETE, e não auto-resolve: resolved_at setado renderizaria como
--    "aprovado" na fila do coordenador. Escopada a kind='exclusion_request'
--    pendente, espelhando "Members can delete ambiguity comments"
--    (20260514170519).
DROP POLICY IF EXISTS "Authors can delete own pending exclusion requests"
  ON project_comments;
CREATE POLICY "Authors can delete own pending exclusion requests"
  ON project_comments
  FOR DELETE USING (
    kind = 'exclusion_request'
    AND author_id = clerk_uid()
    AND resolved_at IS NULL
    AND rejected_at IS NULL
  );

-- 5. Backfill dos pedidos pendentes já existentes.
UPDATE documents d
SET exclusion_pending_at = p.min_created
FROM (
  SELECT document_id, min(created_at) AS min_created
  FROM project_comments
  WHERE kind = 'exclusion_request'
    AND resolved_at IS NULL
    AND rejected_at IS NULL
    AND document_id IS NOT NULL
  GROUP BY document_id
) p
WHERE d.id = p.document_id
  AND d.exclusion_pending_at IS DISTINCT FROM p.min_created;

-- 6. Toggle do recurso por projeto (Configurações → Regras). Ligado por
--    padrão em todos os projetos, inclusive os existentes. Desligar apenas
--    esconde a pergunta do formulário de codificação; pedidos já pendentes
--    continuam valendo (docs escondidos) até decisão do coordenador.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS out_of_scope_enabled BOOLEAN NOT NULL DEFAULT true;

-- 7. Invariante: excluded_at NOT NULL implica exclusion_pending_at NULL.
--    approveExclusionRequest já resolve o project_comments antes do soft
--    delete, mas excludeDocuments (botão "Excluir" manual de Config →
--    Documentos) e qualquer caminho futuro de escrita direta em
--    documents.excluded_at não passam por esse cascade. Sem a trigger, um
--    doc com pedido pendente excluído por essa via manual fica com o
--    comentário de exclusion_request órfão (nunca resolvido) e, se depois
--    restaurado, com excluded_at NULL e exclusion_pending_at ainda
--    NOT NULL — estado que nenhum dos filtros
--    `.is('exclusion_pending_at', null)` (~14 call sites) reverte, tornando
--    o documento invisível para sempre sem caminho de UI para corrigir.
--    SECURITY DEFINER pelo mesmo motivo do item 3: quem faz UPDATE em
--    documents.excluded_at é sempre coordenador (RLS já garante), mas o
--    resolved_at em project_comments deve valer mesmo que o autor original
--    do pedido seja outro pesquisador — a trigger grava um valor derivado,
--    não dependente de permissão de terceiro.
CREATE OR REPLACE FUNCTION public.resolve_exclusion_requests_on_exclude()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.excluded_at IS NOT NULL AND OLD.excluded_at IS NULL THEN
    UPDATE public.project_comments
    SET resolved_at = NEW.excluded_at,
        resolved_by = NEW.excluded_by
    WHERE document_id = NEW.id
      AND kind = 'exclusion_request'
      AND resolved_at IS NULL
      AND rejected_at IS NULL;
  END IF;

  RETURN NULL;  -- trigger AFTER: valor de retorno é ignorado
END;
$$;

DROP TRIGGER IF EXISTS resolve_exclusion_requests_on_exclude_trigger ON documents;
CREATE TRIGGER resolve_exclusion_requests_on_exclude_trigger
  AFTER UPDATE OF excluded_at ON documents
  FOR EACH ROW
  EXECUTE FUNCTION public.resolve_exclusion_requests_on_exclude();

-- 8. Backfill defensivo: cobre reaplicação da migration e o caso raro de um
--    doc já excluído (por caminho manual, antes desta trigger existir) com
--    pedido de exclusão ainda pendente. Dispara o recompute (trigger do
--    item 3) e resolve o invariante do item 7 para dados existentes.
UPDATE project_comments pc
SET resolved_at = d.excluded_at,
    resolved_by = d.excluded_by
FROM documents d
WHERE pc.document_id = d.id
  AND d.excluded_at IS NOT NULL
  AND pc.kind = 'exclusion_request'
  AND pc.resolved_at IS NULL
  AND pc.rejected_at IS NULL;
