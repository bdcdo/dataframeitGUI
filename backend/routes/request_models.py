"""Shared request contracts for the public FastAPI boundary."""

from pydantic import BaseModel, ConfigDict


class StrictRequestModel(BaseModel):
    """Reject keys that are not part of the declared HTTP contract."""

    model_config = ConfigDict(extra="forbid")
