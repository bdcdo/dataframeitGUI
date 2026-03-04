# API Endpoints (FastAPI)

Base URL: `NEXT_PUBLIC_API_URL` (default: `http://localhost:8000`)

## POST /api/pydantic/validate

Compila codigo Pydantic e extrai campos tipados.

**Request:**
```json
{
  "code": "from pydantic import BaseModel, Field\nfrom typing import Literal\n\nclass Codificacao(BaseModel):\n    q1: Literal[\"Sim\", \"Nao\"] = Field(description=\"Pergunta 1\")"
}
```

**Response (sucesso):**
```json
{
  "valid": true,
  "fields": [
    {"name": "q1", "type": "single", "options": ["Sim", "Nao"], "description": "Pergunta 1"}
  ],
  "model_name": "Codificacao",
  "errors": []
}
```

**Response (erro):**
```json
{
  "valid": false,
  "fields": [],
  "model_name": null,
  "errors": ["SyntaxError: invalid syntax (line 3)"]
}
```

## POST /api/llm/run

Inicia execucao async do dataframeit para todos os documentos (ou subset).

**Request:**
```json
{
  "project_id": "uuid",
  "document_ids": ["uuid1", "uuid2"]  // opcional, null = todos
}
```

**Response:**
```json
{
  "job_id": "uuid"
}
```

## POST /api/llm/run-field

Re-roda LLM so para campos especificos (quando Pydantic mudou parcialmente).

**Request:**
```json
{
  "project_id": "uuid",
  "field_names": ["q1_1", "q1_2"],
  "document_ids": ["uuid1"]  // opcional
}
```

**Response:**
```json
{
  "job_id": "uuid"
}
```

## GET /api/llm/status/{job_id}

Polling de progresso de um job LLM.

**Response:**
```json
{
  "status": "running",
  "progress": 45,
  "total": 220,
  "errors": []
}
```

Status possiveis: `running`, `completed`, `error`
