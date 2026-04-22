"""Unit tests for _extract_pydantic_location in services.llm_runner."""
from services.llm_runner import _extract_pydantic_location


def test_syntax_error_returns_line_and_column():
    try:
        compile('x = "hello\n', "<pydantic_schema>", "exec")
    except SyntaxError as e:
        line, col = _extract_pydantic_location(e, "")
        assert line == e.lineno
        assert col == e.offset


def test_traceback_with_pydantic_schema_frame_extracts_line():
    fake_tb = (
        'Traceback (most recent call last):\n'
        '  File "services/llm_runner.py", line 311, in run_llm\n'
        '    model_class = _compile_model(pydantic_code)\n'
        '  File "<pydantic_schema>", line 7, in <module>\n'
        '    tipo: Literal["a\\q"]\n'
        "re.error: bad escape \\q at position 0\n"
    )
    line, col = _extract_pydantic_location(ValueError("bad escape"), fake_tb)
    assert line == 7
    assert col is None


def test_unrelated_traceback_returns_none():
    fake_tb = (
        'Traceback (most recent call last):\n'
        '  File "services/other.py", line 42, in foo\n'
        "ValueError: unrelated\n"
    )
    line, col = _extract_pydantic_location(ValueError("x"), fake_tb)
    assert line is None
    assert col is None
