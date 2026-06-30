from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_service_key: str = ""
    cors_origins: list[str] = ["http://localhost:3000"]
    cors_origin_regex: str | None = None

    # Verificação do JWT do Clerk (template "supabase"). O backend valida o
    # mesmo token que o frontend emite. Agnóstico ao algoritmo: HS256 usa o
    # Supabase JWT secret; RS256 usa o JWKS do Clerk. Fail-closed — sem nenhum
    # destes configurado, toda rota autenticada rejeita (ver services/auth.py).
    supabase_jwt_secret: str = ""  # HS256
    clerk_jwks_url: str = (
        ""  # RS256 (ex: https://<slug>.clerk.accounts.dev/.well-known/jwks.json)
    )
    clerk_jwt_issuer: str = ""  # validação opcional de `iss`
    # Audience esperada. Default "authenticated" (valor que o template "supabase"
    # emite), então a checagem de `aud` vem LIGADA por padrão — fecha tokens
    # emitidos para outra audiência mas assinados com a mesma chave. Setar ""
    # explicitamente desliga a checagem (escape hatch para deploys cujo aud difira).
    clerk_jwt_audience: str = "authenticated"
    # Tolerância (segundos) para skew de relógio / expiração de borda no decode
    # do JWT. O token do template expira em ~60s e é pollado por minutos.
    jwt_leeway_seconds: int = 30

    model_config = {"env_file": ".env"}


settings = Settings()
