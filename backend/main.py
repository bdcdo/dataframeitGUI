from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from routes.pydantic_routes import router as pydantic_router
from routes.llm_routes import router as llm_router

app = FastAPI(title="GUI Analise Sistematica API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pydantic_router, prefix="/api/pydantic", tags=["pydantic"])
app.include_router(llm_router, prefix="/api/llm", tags=["llm"])


@app.get("/health")
async def health():
    return {"status": "ok"}
