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
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException

from config import settings
from services.supabase_client import get_supabase

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


def _decode_kwargs() -> dict:
    options: dict = {}
    kwargs: dict = {}
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
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token inválido", headers=_BEARER)

    alg = header.get("alg")
    try:
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise HTTPException(
                    status_code=503,
                    detail="Autenticação não configurada no servidor",
                )
            claims = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                **_decode_kwargs(),
            )
        elif alg == "RS256":
            if not settings.clerk_jwks_url:
                raise HTTPException(
                    status_code=503,
                    detail="Autenticação não configurada no servidor",
                )
            signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                **_decode_kwargs(),
            )
        else:
            raise HTTPException(
                status_code=401,
                detail=f"Algoritmo de token não suportado: {alg}",
                headers=_BEARER,
            )
    except HTTPException:
        raise
    except jwt.PyJWTError:
        # Cobre assinatura inválida, expiração, issuer/audience errados e
        # falhas do PyJWKClient (PyJWKClientError herda de PyJWTError).
        raise HTTPException(
            status_code=401, detail="Token inválido ou expirado", headers=_BEARER
        )

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


def _is_master(sb, user_id: str) -> bool:
    res = (
        sb.table("master_users")
        .select("user_id")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return bool(res.data)


def _is_project_member(sb, project_id: str, user_id: str) -> bool:
    if _is_master(sb, user_id):
        return True
    proj = (
        sb.table("projects")
        .select("created_by")
        .eq("id", project_id)
        .limit(1)
        .execute()
    )
    if proj.data and proj.data[0].get("created_by") == user_id:
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
    """
    sb = get_supabase()
    if _is_master(sb, user.id):
        return
    proj = (
        sb.table("projects")
        .select("created_by")
        .eq("id", project_id)
        .limit(1)
        .execute()
    )
    if proj.data and proj.data[0].get("created_by") == user.id:
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
    if mem.data:
        return
    raise HTTPException(
        status_code=403, detail="Acesso negado: requer coordenador do projeto"
    )


def require_job_access(job_id: str, user: AuthUser) -> str:
    """Autoriza qualquer membro do projeto dono do job. Retorna o project_id.

    Usado por /status/{job_id}: ver progresso é leitura, basta ser membro
    (criador, membro ou master). Levanta 404 se o job não existe, 403 se o
    usuário não pertence ao projeto.
    """
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
    project_id = run.data[0]["project_id"]
    if _is_project_member(sb, project_id, user.id):
        return project_id
    raise HTTPException(
        status_code=403, detail="Acesso negado: requer membro do projeto"
    )
