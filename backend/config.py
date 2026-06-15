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
    clerk_jwks_url: str = ""  # RS256 (ex: https://<slug>.clerk.accounts.dev/.well-known/jwks.json)
    clerk_jwt_issuer: str = ""  # validação opcional de `iss`
    clerk_jwt_audience: str = ""  # validação opcional de `aud` (template costuma usar "authenticated")

    model_config = {"env_file": ".env"}


settings = Settings()
