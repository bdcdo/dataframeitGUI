from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_service_key: str = ""
    cors_origins: list[str] = ["http://localhost:3000"]
    cors_origin_regex: str | None = None

    model_config = {"env_file": ".env"}


settings = Settings()
