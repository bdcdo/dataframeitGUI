FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml .
RUN uv pip install --system --no-cache \
    "fastapi>=0.137.2" \
    "uvicorn[standard]>=0.49.0" \
    "pydantic>=2.13.4" \
    "pydantic-settings>=2.14.1" \
    "supabase>=2.31.0" \
    "dataframeit>=0.6.0" \
    "pandas>=3.0.3" \
    "langchain-google-genai>=4.2.5" \
    "langchain-openai>=1.3.2" \
    "langchain-anthropic>=1.4.6"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
