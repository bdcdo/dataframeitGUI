FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir \
    "fastapi>=0.115" \
    "uvicorn[standard]>=0.34" \
    "pydantic>=2.10" \
    "pydantic-settings>=2.7" \
    "supabase>=2.11" \
    "dataframeit>=0.5.3" \
    "pandas>=2.2"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
