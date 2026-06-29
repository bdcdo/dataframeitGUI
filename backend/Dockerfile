FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml .
RUN uv pip install --system --no-cache \
    "fastapi>=0.138.0" \
    "uvicorn[standard]>=0.49.0" \
    "pydantic>=2.13.4" \
    "pydantic-settings>=2.14.2" \
    "supabase>=2.31.0" \
    "dataframeit>=0.6.0" \
    "pandas>=3.0.3" \
    "langchain-google-genai>=4.2.5" \
    "langchain-openai>=1.3.3" \
    "langchain-anthropic>=1.4.7"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
