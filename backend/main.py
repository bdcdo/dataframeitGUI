import logging
import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from routes.pydantic_routes import router as pydantic_router
from routes.llm_routes import router as llm_router

logger = logging.getLogger(__name__)


def _normalize_origin(value: str) -> str:
    return value.strip().rstrip("/").lower()


_ALLOWED_ORIGINS = {_normalize_origin(o) for o in settings.cors_origins if o}
_ORIGIN_REGEX = (
    re.compile(settings.cors_origin_regex) if settings.cors_origin_regex else None
)


def _match_origin(origin: str | None) -> str | None:
    # Returns the Origin string to echo back, or None if it isn't authorized.
    # Mirrors CORSMiddleware's matching semantics so success and 500 responses
    # agree on which origins are allowed.
    if not origin:
        return None
    normalized = _normalize_origin(origin)
    if normalized in _ALLOWED_ORIGINS:
        return origin
    if _ORIGIN_REGEX is not None and _ORIGIN_REGEX.fullmatch(origin):
        return origin
    return None


app = FastAPI(title="dataframeit API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cors_headers_for(request: Request) -> dict[str, str]:
    headers: dict[str, str] = {"Vary": "Origin"}
    allowed = _match_origin(request.headers.get("origin"))
    if allowed is not None:
        headers["Access-Control-Allow-Origin"] = allowed
        headers["Access-Control-Allow-Credentials"] = "true"
    return headers


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # CORSMiddleware sits below ServerErrorMiddleware in Starlette's stack, so
    # 500s from unhandled exceptions never pass back through it. Without this
    # handler the response goes out without Access-Control-Allow-Origin, the
    # browser hides it from the frontend as a "CORS error" (status null), and
    # we lose any chance to surface the real failure. Echo the headers manually
    # for authorized origins.
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error"},
        headers=_cors_headers_for(request),
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    # Unlike the generic Exception handler above, HTTPException responses still
    # flow back through CORSMiddleware, so it adds Access-Control-Allow-Origin /
    # Vary on its own. We only override `detail` to collapse 5xx bodies into an
    # opaque payload (the original `detail` may carry internal messages); 4xx
    # detail is preserved so clients can react to validation/auth errors.
    if exc.status_code >= 500:
        logger.exception(
            "HTTPException %s on %s %s", exc.status_code, request.method, request.url.path
        )
        content = {"detail": "Internal Server Error"}
    else:
        content = {"detail": exc.detail}

    return JSONResponse(
        status_code=exc.status_code, content=content, headers=exc.headers or None
    )


app.include_router(pydantic_router, prefix="/api/pydantic", tags=["pydantic"])
app.include_router(llm_router, prefix="/api/llm", tags=["llm"])


@app.get("/health")
async def health():
    return {"status": "ok"}
