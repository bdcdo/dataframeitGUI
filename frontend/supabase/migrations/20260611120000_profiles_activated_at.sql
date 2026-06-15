-- Pré-registro de membros (spec 002): coluna de ativação.
-- NULL = membro pendente (nunca teve acesso autenticado).
-- Preenchida uma única vez: webhook user.created ou fallback em getAuthUser().

ALTER TABLE profiles ADD COLUMN activated_at TIMESTAMPTZ;

-- Backfill: profiles existentes contam como ativos (limitação aceita em research.md D2:
-- convidados antigos nunca-logados ficam como "ativos").
UPDATE profiles SET activated_at = created_at;
