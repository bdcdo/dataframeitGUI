import logging
import re
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from routes.llm_routes import router as llm_router
from routes.pydantic_routes import router as pydantic_router
from services.auth import require_authenticated_user

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: "FastAPI"):
    # Readiness do gate de auth: o boot é fail-closed, mas /health sempre retorna
    # 200. Sem este aviso, um deploy sem o secret/JWKS sobe "saudável" enquanto
    # toda rota autenticada devolve 503, sem nada no log apontando a causa.
    if not settings.supabase_jwt_secret and not settings.clerk_jwks_url:
        logger.error(
            "Auth fail-closed: nem SUPABASE_JWT_SECRET nem CLERK_JWKS_URL "
            "configurados — toda rota autenticada retornará 503."
        )
    elif not settings.clerk_jwt_audience and not settings.clerk_jwt_issuer:
        logger.warning(
            "JWT sem validação de aud/iss (CLERK_JWT_AUDIENCE e CLERK_JWT_ISSUER "
            "vazios) — recomendado setá-las em produção."
        )
    yield


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


def _cors_headers_for(request: Request) -> dict[str, str]:
    headers: dict[str, str] = {"Vary": "Origin"}
    allowed = _match_origin(request.headers.get("origin"))
    if allowed is not None:
        headers["Access-Control-Allow-Origin"] = allowed
        headers["Access-Control-Allow-Credentials"] = "true"
    return headers


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


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    # Unlike the generic Exception handler above, HTTPException responses still
    # flow back through CORSMiddleware, so it adds Access-Control-Allow-Origin /
    # Vary on its own. We collapse the body ONLY for 500 (an explicit
    # HTTPException(500) may carry an internal message). Deliberate 5xx signals —
    # notably the auth gate's fail-closed 503s — preserve `detail`, which is a
    # safe, actionable message ("Autenticação não configurada no servidor",
    # "Não foi possível verificar autorização"); 4xx detail is preserved too so
    # clients can react to validation/auth errors.
    if exc.status_code >= 500:
        logger.exception(
            "HTTPException %s on %s %s",
            exc.status_code,
            request.method,
            request.url.path,
        )
    if exc.status_code == 500:
        content = {"detail": "Internal Server Error"}
    else:
        content = {"detail": exc.detail}

    return JSONResponse(
        status_code=exc.status_code, content=content, headers=exc.headers or None
    )


async def health():
    return {"status": "ok"}


def require_llm_enabled() -> None:
    if not settings.llm_enabled:
        raise HTTPException(
            status_code=403,
            detail="Funcionalidades de LLM estão desabilitadas.",
        )


# Docs (/docs, /redoc, /openapi.json) desligados por padrão — fail-safe. Num
# serviço internet-facing, /openapi.json anônimo enumera o schema de todas as
# rotas protegidas. Ligar só em dev com ENABLE_DOCS=true (ver config.py).
#
# A construção do app é uma factory para que o gate de docs seja testável sem
# depender do ambiente do processo: o `app` de módulo (produção) usa o default
# `settings.enable_docs`, enquanto os testes passam `enable_docs` explícito.
def create_app(*, enable_docs: bool = settings.enable_docs) -> FastAPI:
    app = FastAPI(
        title="dataframeit API",
        lifespan=lifespan,
        docs_url="/docs" if enable_docs else None,
        redoc_url="/redoc" if enable_docs else None,
        openapi_url="/openapi.json" if enable_docs else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_exception_handler(Exception, unhandled_exception_handler)
    # Starlette tipa ExceptionHandler como Callable[[Request, Exception], ...]
    # (types.py), sem generico sobre a subclasse; o dispatch real do Starlette
    # so chama http_exception_handler para HTTPException, entao a assinatura
    # mais estreita e segura em runtime, so incompativel para o mypy.
    app.add_exception_handler(HTTPException, http_exception_handler)  # type: ignore[arg-type]

    # Autenticação estrutural: toda rota dos dois routers exige um JWT válido por
    # dependency de router, não só pela chamada manual no corpo do handler. Assim,
    # uma rota nova que esqueça o `Depends(require_authenticated_user)` não fica
    # anônima por omissão. A autorização (coordenador/membro) continua por rota,
    # pois depende do project_id do payload. FastAPI deduplica a dependência quando
    # o handler também a declara para receber o `AuthUser`.
    app.include_router(
        llm_router,
        prefix="/api/llm",
        tags=["llm"],
        dependencies=[
            Depends(require_llm_enabled),
            Depends(require_authenticated_user),
        ],
    )
    app.include_router(
        pydantic_router,
        prefix="/api/pydantic",
        tags=["pydantic"],
        dependencies=[Depends(require_authenticated_user)],
    )

    app.get("/health")(health)

    return app


app = create_app()
