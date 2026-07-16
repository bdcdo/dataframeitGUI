from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_service_key: str = ""
    cors_origins: list[str] = ["http://localhost:3000"]
    cors_origin_regex: str | None = None

    # Verificação do JWT do Clerk. O backend valida o mesmo session token que o
    # frontend emite para o Supabase. Agnóstico ao algoritmo: HS256 usa o
    # Supabase JWT secret; RS256 usa o JWKS do Clerk. Fail-closed — sem nenhum
    # destes configurado, toda rota autenticada rejeita (ver services/auth.py).
    supabase_jwt_secret: str = ""  # HS256
    clerk_jwks_url: str = (
        ""  # RS256 (ex: https://<slug>.clerk.accounts.dev/.well-known/jwks.json)
    )
    # Issuer esperado (Frontend API URL da instância Clerk). Obrigatório quando
    # clerk_jwks_url está setado: é o que distingue a instância de produção da de
    # desenvolvimento. Sem ele, um token da instância errada falha no lookup do
    # `kid` no JWKS e vira 503 ("upstream indisponível") em vez de 401 — o erro
    # aponta para a rede do Clerk quando a causa é credencial de outro tenant.
    # Ver services/auth.py:_require_issuer.
    clerk_jwt_issuer: str = ""
    # Tolerância (segundos) para skew de relógio / expiração de borda no decode
    # do JWT. O session token expira em ~60s e é pollado por minutos.
    jwt_leeway_seconds: int = 30

    # Endpoints de documentação (/docs, /redoc, /openapi.json). Fechados por
    # padrão (fail-safe): num serviço internet-facing, /openapi.json anônimo
    # vaza o schema de todas as rotas protegidas. Ligar só em dev via
    # ENABLE_DOCS=true no .env. Produção (Fly) mantém o default fechado — nada
    # a setar no fly.toml.
    enable_docs: bool = False

    # Fixed-window budget shared by POST /api/llm/run and /run-field. The
    # counter lives in Postgres, so every Fly machine enforces the same limit.
    llm_rate_limit_requests: int = Field(default=5, ge=1, le=10_000)
    llm_rate_limit_window_seconds: int = Field(default=60, ge=1, le=86_400)

    model_config = {"env_file": ".env"}


settings = Settings()
