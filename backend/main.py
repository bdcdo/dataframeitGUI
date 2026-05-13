import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from routes.pydantic_routes import router as pydantic_router
from routes.llm_routes import router as llm_router

logger = logging.getLogger(__name__)

app = FastAPI(title="dataframeit API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # CORSMiddleware sits below ServerErrorMiddleware in Starlette's stack, so
    # 500s from unhandled exceptions never pass back through it. Without this
    # handler the response goes out without Access-Control-Allow-Origin, the
    # browser hides it from the frontend as a "CORS error" (status null), and
    # we lose any chance to surface the real failure. Echo the headers manually
    # for authorized origins.
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)

    origin = request.headers.get("origin")
    headers: dict[str, str] = {"Vary": "Origin"}
    if origin and origin in settings.cors_origins:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"

    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error"},
        headers=headers,
    )


app.include_router(pydantic_router, prefix="/api/pydantic", tags=["pydantic"])
app.include_router(llm_router, prefix="/api/llm", tags=["llm"])


@app.get("/health")
async def health():
    return {"status": "ok"}
