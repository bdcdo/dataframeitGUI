"""
Autenticação e autorização do backend FastAPI.

O backend é internet-facing e usa a service key do Supabase (que bypassa RLS),
então NÃO pode confiar no caller: toda rota que toca dados ou dispara compute
precisa validar o JWT do Clerk e checar a autorização do usuário no projeto.

O token é o mesmo que o frontend emite para o Supabase via
`getToken({ template: "supabase" })`. O RLS identifica o usuário pela claim
`supabase_uid` (ver migrations 20260401*_clerk_uid_rls.sql), então é ela —
com fallback para `sub` — que usamos como user_id.

Fail-closed: sem configuração de verificação, ou com token/claim inválido, a
request é rejeitada. Nunca passa.
"""

import logging
from dataclasses import dataclass
from typing import Any, cast

import jwt
from fastapi import Header, HTTPException

from config import settings
from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

_BEARER = {"WWW-Authenticate": "Bearer"}


@dataclass
class AuthUser:
    id: str


_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    # PyJWKClient cacheia as signing keys internamente; instanciamos uma vez.
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(settings.clerk_jwks_url)
    return _jwks_client


def _allowed_algorithms() -> list[str]:
    """Algoritmos aceitos, derivados da config (fail-closed).

    RS256 é o mecanismo de produção (JWKS do Clerk). HS256 (Supabase JWT
    secret) só é aceito quando o JWKS NÃO está configurado — i.e., no estado
    de rollback. Com o JWKS setado, um token forjado com `alg=HS256` (mesmo de
    posse do secret legado vazado) cai fora da allowlist e é rejeitado, fechando
    o downgrade de algoritmo.
    """
    if settings.clerk_jwks_url:
        return ["RS256"]
    if settings.supabase_jwt_secret:
        return ["HS256"]
    return []


def _decode_kwargs() -> dict:
    # require=["exp"]: rejeita token sem claim de expiração — sem isto, um token
    # sem `exp` jamais expiraria. Vale para HS256 e RS256 (defesa em profundidade).
    options: dict = {"require": ["exp"]}
    # leeway absorve skew de relógio e expiração de borda: o token do template
    # "supabase" expira em ~60s e é pollado por minutos, então uma diferença de
    # alguns segundos entre Clerk e o backend não deve derrubar uma run em curso.
    kwargs: dict = {"leeway": settings.jwt_leeway_seconds}
    # O template "supabase" costuma emitir aud="authenticated". Só validamos a
    # audience se ela estiver configurada; caso contrário desligamos a checagem
    # para não rejeitar tokens válidos.
    if settings.clerk_jwt_audience:
        kwargs["audience"] = settings.clerk_jwt_audience
    else:
        options["verify_aud"] = False
    if settings.clerk_jwt_issuer:
        kwargs["issuer"] = settings.clerk_jwt_issuer
    kwargs["options"] = options
    return kwargs


def verify_jwt(token: str) -> AuthUser:
    """Valida assinatura/exp/iss/aud do JWT e retorna o usuário.

    Agnóstico ao algoritmo: HS256 é validado com o Supabase JWT secret
    (integração legada Clerk↔Supabase); RS256 via JWKS do Clerk.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=401, detail="Token inválido", headers=_BEARER
        ) from e

    alg = header.get("alg")
    allowed = _allowed_algorithms()
    if not allowed:
        # Nenhum mecanismo de verificação configurado: fail-closed (503, não 401),
        # distinguindo "servidor mal configurado" de "credencial inválida".
        raise HTTPException(
            status_code=503, detail="Autenticação não configurada no servidor"
        )
    if alg not in allowed:
        raise HTTPException(
            status_code=401,
            detail=f"Algoritmo de token não aceito: {alg}",
            headers=_BEARER,
        )

    try:
        if alg == "HS256":
            claims = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                **_decode_kwargs(),
            )
        else:  # RS256 — único outro valor possível na allowlist
            try:
                signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
            except jwt.PyJWKClientError as e:
                # JWKS indisponível (rede/5xx do Clerk) ou kid não encontrado:
                # fail-closed com 503 (não 401), igual aos guards de banco, para
                # não disfarçar uma indisponibilidade de upstream como "token
                # inválido" e disparar re-login inútil em massa.
                logger.warning("Falha ao resolver signing key via JWKS: %s", e)
                raise HTTPException(
                    status_code=503, detail="Não foi possível verificar autorização"
                ) from e
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                **_decode_kwargs(),
            )
    except HTTPException:
        raise
    except jwt.PyJWTError as e:
        # Cobre assinatura inválida, expiração e issuer/audience errados.
        raise HTTPException(
            status_code=401, detail="Token inválido ou expirado", headers=_BEARER
        ) from e

    user_id = claims.get("supabase_uid") or claims.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=401,
            detail="Token sem identificação de usuário",
            headers=_BEARER,
        )
    return AuthUser(id=str(user_id))


def require_authenticated_user(
    authorization: str | None = Header(default=None),
) -> AuthUser:
    """Dependência FastAPI: exige `Authorization: Bearer <jwt>` válido."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401, detail="Autenticação necessária", headers=_BEARER
        )
    token = authorization[7:].strip()
    return verify_jwt(token)


# Os lookups de autorização abaixo são indexados no banco: `master_users.user_id`
# é PK, `projects.id` é PK, `project_members(project_id, user_id)` é UNIQUE e
# `llm_runs.job_id` é UNIQUE (ver migrations). Por isso /status/{job_id} pode ser
# pollado a cada 2s sem cache de autorização — checar a cada poll é o caminho
# mais seguro e os índices mantêm o custo baixo.
def _is_master(sb, user_id: str) -> bool:
    res = (
        sb.table("master_users")
        .select("user_id")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return bool(res.data)


def _is_project_creator_or_master(sb, project_id: str, user_id: str) -> bool:
    """True se o usuário é master global ou criador do projeto.

    Núcleo comum a `_is_project_member` (qualquer membro) e
    `require_project_coordinator` (só coordenador): ambos liberam master e
    criador antes de checar a tabela `project_members`. Centralizado aqui para
    que uma mudança nessa regra (ex.: projeto soft-deleted, segunda fonte de
    master) valha nos dois caminhos sem divergir.
    """
    if _is_master(sb, user_id):
        return True
    proj = (
        sb.table("projects")
        .select("created_by")
        .eq("id", project_id)
        .limit(1)
        .execute()
    )
    return bool(proj.data and proj.data[0].get("created_by") == user_id)


def _is_project_member(sb, project_id: str, user_id: str) -> bool:
    if _is_project_creator_or_master(sb, project_id, user_id):
        return True
    mem = (
        sb.table("project_members")
        .select("id")
        .eq("project_id", project_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return bool(mem.data)


def require_project_coordinator(project_id: str, user: AuthUser) -> None:
    """Autoriza só coordenador do projeto (master, criador ou role coordenador).

    Replica a regra de `getProjectAccessContext` do frontend
    (frontend/src/lib/auth.ts). Levanta 403 quando não autorizado.

    Fail-closed: uma falha de infra ao consultar o banco vira 503 (não 500
    genérico nem liberação), distinguindo "não pude verificar" de "negado".
    """
    try:
        sb = get_supabase()
        if _is_project_creator_or_master(sb, project_id, user.id):
            return
        mem = (
            sb.table("project_members")
            .select("role")
            .eq("project_id", project_id)
            .eq("user_id", user.id)
            .eq("role", "coordenador")
            .limit(1)
            .execute()
        )
        authorized = bool(mem.data)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Falha ao verificar coordenador (project_id=%s)", project_id)
        raise HTTPException(
            status_code=503, detail="Não foi possível verificar autorização"
        ) from e
    if not authorized:
        raise HTTPException(
            status_code=403, detail="Acesso negado: requer coordenador do projeto"
        )


def require_writable_user(user: AuthUser, impersonating: bool) -> None:
    """Interlock de somente-leitura da impersonação master (issue #428).

    Único gate server-side de escrita da impersonação: as Server Actions Next
    escrevem via RLS (Clerk JWT), mas esta rota usa service-key (sem RLS por
    trás), então o interlock vive aqui. Um master em modo "visualizar como outro
    membro" (?viewAsUser=) não dispara execução de LLM: o botão já fica
    `disabled` no client (RunLlmButton) e o servidor recusa (403) caso a chamada
    chegue mesmo assim.

    `impersonating` vem do client (searchParam per-tab que o backend não recebe
    de outra forma); logo esta barreira não detém um master adversarial, que
    simplesmente sai do view-as — só a escrita ACIDENTAL durante a observação.
    Não-master ignora o sinal. Fail-closed: falha de infra ao verificar master
    vira 503, não liberação.
    """
    if not impersonating:
        return
    try:
        sb = get_supabase()
        is_master = _is_master(sb, user.id)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Falha ao verificar master (user_id=%s)", user.id)
        raise HTTPException(
            status_code=503, detail="Não foi possível verificar autorização"
        ) from e
    if is_master:
        raise HTTPException(
            status_code=403,
            detail="Ação indisponível ao visualizar como outro membro.",
        )


def require_job_access(job_id: str, user: AuthUser) -> None:
    """Autoriza qualquer membro do projeto dono do job.

    Usado por /status/{job_id}: ver progresso é leitura, basta ser membro
    (criador, membro ou master). Levanta **404** tanto quando o job não existe
    quanto quando o usuário não pertence ao projeto — mesmo código nos dois
    casos para não vazar a existência de jobs de outros projetos (oráculo de
    enumeração). Levanta 503 se a verificação no banco falhar.
    """
    try:
        sb = get_supabase()
        run = (
            sb.table("llm_runs")
            .select("project_id")
            .eq("job_id", job_id)
            .limit(1)
            .execute()
        )
        if not run.data:
            raise HTTPException(status_code=404, detail="Job não encontrado")
        row = cast(dict[str, Any], run.data[0])
        project_id = row["project_id"]
        is_member = _is_project_member(sb, project_id, user.id)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Falha ao verificar acesso ao job (job_id=%s)", job_id)
        raise HTTPException(
            status_code=503, detail="Não foi possível verificar autorização"
        ) from e
    if not is_member:
        raise HTTPException(status_code=404, detail="Job não encontrado")
