FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /usr/local/bin/uv

# O Compose preserva .venv em um volume separado do cache do uv; copiar evita
# fallback de hardlink entre filesystems durante a reconciliacao no startup.
ENV UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-cache

ENV PATH="/app/.venv/bin:$PATH"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
