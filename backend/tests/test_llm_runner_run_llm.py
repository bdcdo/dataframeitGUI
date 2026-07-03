"""Teste de integração de run_llm (issue #377).

Pré-requisito bloqueante do refactor: hoje nenhum teste chama `run_llm`
diretamente (os outros arquivos `test_llm_runner_*` só cobrem os helpers já
extraídos). Mocka só a fronteira externa — cliente Supabase e `dataframeit` —
e deixa rodar de verdade a compilação Pydantic, o flatten/filtro de campos e a
classificação de cobertura, para servir de rede de segurança antes de extrair
o laço de pós-processamento por linha (linhas 970-1120).

Cobre os 4 cenários pedidos pela issue: happy path, run parcial (não falha),
run comprometida (RuntimeError) e exceção não tratada persistida.
"""

import asyncio
import sys
from types import SimpleNamespace

from services.llm_runner import _jobs, init_job, run_llm

JOB_ID = "job-1"
PROJECT_ID = "proj-1"

PYDANTIC_CODE = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    campo_a: str = Field(description="Campo A")
    campo_b: str = Field(description="Campo B")
    campo_c: str = Field(description="Campo C")
"""


class _FakeQuery:
    def __init__(self, data):
        self._data = data

    def eq(self, *a, **k):
        return self

    def in_(self, *a, **k):
        return self

    def is_(self, *a, **k):
        return self

    def single(self, *a, **k):
        return self

    def maybe_single(self, *a, **k):
        return self

    def execute(self):
        return SimpleNamespace(data=self._data)


class _RaisingQuery(_FakeQuery):
    def execute(self):
        raise self._data


class _FakeTable:
    def __init__(self, select_data=None, select_error=None):
        self.select_data = select_data
        self.select_error = select_error
        self.insert_calls: list[dict] = []
        self.update_calls: list[dict] = []

    def select(self, *a, **k):
        if self.select_error is not None:
            return _RaisingQuery(self.select_error)
        return _FakeQuery(self.select_data)

    def insert(self, payload):
        self.insert_calls.append(payload)
        return _FakeQuery(payload)

    def update(self, payload):
        self.update_calls.append(payload)
        return _FakeQuery(payload)


class _FakeSupabase:
    def __init__(self, tables: dict[str, _FakeTable]):
        self._tables = tables

    def table(self, name):
        return self._tables[name]


def _project_row(**overrides) -> dict:
    row: dict = {
        "pydantic_code": PYDANTIC_CODE,
        "prompt_template": None,
        "llm_provider": "google",
        "llm_model": "gemini-2.5-flash",
        "llm_kwargs": {},
        "description": None,
        "pydantic_fields": [],
        "schema_version_major": 1,
        "schema_version_minor": 0,
        "schema_version_patch": 0,
    }
    row.update(overrides)
    return row


def _docs(n: int) -> list[dict]:
    return [
        {
            "id": f"doc-{i}",
            "text": f"texto {i}",
            "title": f"Doc {i}",
            "external_id": None,
        }
        for i in range(n)
    ]


def _make_fake_dataframeit(row_specs: dict[str, dict]):
    """row_specs: {doc_id: {field: value}}.

    Campos ausentes do spec de um doc simulam resposta incompleta do
    provider (o dataframeit real também não garante 100% de cobertura).
    """

    def _fake(batch_df, model_class, prompt_template, **kwargs):
        out = batch_df.copy()
        field_names = [
            f for f in model_class.model_fields if not f.endswith("_justification")
        ]
        for field in field_names:
            out[field] = [
                row_specs.get(doc_id, {}).get(field) for doc_id in batch_df["id"]
            ]
        out["_dataframeit_status"] = "processed"
        out["_error_details"] = None
        return out

    return _fake


def _build_supabase(project_row, docs, *, documents_error=None) -> _FakeSupabase:
    return _FakeSupabase(
        {
            "projects": _FakeTable(select_data=project_row),
            "documents": _FakeTable(select_data=docs, select_error=documents_error),
            "responses": _FakeTable(),
            "llm_runs": _FakeTable(),
        }
    )


def _run_llm_sync(monkeypatch, sb: _FakeSupabase, row_specs: dict[str, dict]) -> None:
    monkeypatch.setattr("services.llm_runner.get_supabase", lambda: sb)
    monkeypatch.setitem(
        sys.modules,
        "dataframeit",
        SimpleNamespace(dataframeit=_make_fake_dataframeit(row_specs)),
    )
    init_job(JOB_ID, PROJECT_ID, "all")
    asyncio.run(run_llm(JOB_ID, PROJECT_ID))


def _last_update_where(table: _FakeTable, **kv) -> dict | None:
    for payload in reversed(table.update_calls):
        if all(payload.get(k) == v for k, v in kv.items()):
            return payload
    return None


def teardown_function(_fn):
    _jobs.clear()


def test_run_llm_happy_path(monkeypatch):
    docs = _docs(2)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    inserts = sb.table("responses").insert_calls
    assert len(inserts) == 2
    assert all(
        row["is_partial"] is False and row["is_latest"] is True for row in inserts
    )
    assert all(row["llm_error"] is None for row in inserts)

    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert "error_message" not in completion  # sem warnings no happy path

    project_updates = sb.table("projects").update_calls
    assert any("pydantic_hash" in payload for payload in project_updates)


def test_run_llm_partial_run_does_not_fail(monkeypatch):
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    # doc-0 só recebe 1 de 3 campos -> coverage 0.33 < 0.5 (partial_coverage_threshold)
    row_specs["doc-0"] = {"campo_a": "a"}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    assert _jobs[JOB_ID]["processed_partial"] == 1
    assert _jobs[JOB_ID]["processed_complete"] == 3
    assert _jobs[JOB_ID]["processed_empty"] == 0

    inserts = sb.table("responses").insert_calls
    assert len(inserts) == 4
    partial_row = next(row for row in inserts if row["document_id"] == "doc-0")
    assert partial_row["is_partial"] is True
    assert (
        partial_row["is_latest"] is False
    )  # respostas parciais nascem is_latest=false

    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert "Warnings (1 doc(s))" in completion["error_message"]


def test_run_llm_compromised_run_raises_runtime_error(monkeypatch):
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    # 2 de 4 docs com cobertura baixa -> partial_ratio 0.5 >= run_failure_threshold (0.3)
    row_specs["doc-0"] = {"campo_a": "a"}
    row_specs["doc-1"] = {"campo_a": "a"}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "RuntimeError"
    assert "Run comprometida" in _jobs[JOB_ID]["errors"][0]

    # As respostas já foram gravadas (com is_latest=false) ANTES do raise —
    # o RuntimeError só marca a run como erro, não desfaz o que já foi salvo.
    inserts = sb.table("responses").insert_calls
    assert len(inserts) == 4

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "Run comprometida" in error_update["error_message"]


def test_run_llm_unhandled_exception_is_persisted(monkeypatch):
    sb = _build_supabase(_project_row(), _docs(2), documents_error=ValueError("boom"))

    _run_llm_sync(monkeypatch, sb, row_specs={})

    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "ValueError"
    assert _jobs[JOB_ID]["errors"] == ["boom"]

    # Falhou antes de qualquer processamento: nenhuma resposta foi inserida.
    assert sb.table("responses").insert_calls == []

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert error_update["error_message"] == "boom"
