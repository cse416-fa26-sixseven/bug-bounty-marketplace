"""HTTP entrypoint for the analysis service.

- `GET /health`: liveness.
- `POST /analyze`: stateless Slither + LLM analysis of one source file.
- When `DATABASE_URL` and a source store (`SOURCE_STORAGE_BLOB_CONTAINER_URL`
  or `SOURCE_STORAGE_DIR`) are set, a background thread also runs the job
  poller (see worker.py), which analyses contracts the API has queued and
  writes their findings to Postgres.
"""

import logging
import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from analysis import __version__
from analysis.config import Settings
from analysis.findings import parse_detectors, severity_for
from analysis.llm import explanations_for, make_explainer
from analysis.pgsafe import without_nul
from analysis.slither_runner import SlitherError, run_slither
from analysis.solc import UnsupportedSolcError, pick_solc
from analysis.worker import load_dotenv
from analysis.worker import run as run_worker

log = logging.getLogger("analysis.app")


def _configure_logging() -> None:
    """uvicorn only configures its own loggers; without this every
    `analysis.*` message (poller started, jobs claimed and analysed) is lost."""
    logger = logging.getLogger("analysis")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    _configure_logging()
    # Local convenience: pick up workers/analysis/.env (e.g. LLM_API_KEY).
    if os.environ.get("ANALYSIS_LOAD_DOTENV", "1") != "0":
        load_dotenv(Settings.dotenv_path(), os.environ)
    settings = Settings.from_env()
    app.state.settings = settings
    app.state.explainer = make_explainer(settings)
    app.state.worker = None
    stop = threading.Event()
    if settings.database_url and settings.source_storage_configured:
        app.state.worker = threading.Thread(
            target=run_worker,
            args=(settings, stop, app.state.explainer),
            name="job-poller",
            daemon=True,
        )
        app.state.worker.start()
    else:
        log.info(
            "job poller off: set DATABASE_URL and SOURCE_STORAGE_BLOB_CONTAINER_URL"
            " (or SOURCE_STORAGE_DIR) to enable it"
        )
    try:
        yield
    finally:
        stop.set()
        if app.state.worker is not None:
            app.state.worker.join(timeout=10)


app = FastAPI(title="bbm-analysis", version=__version__, lifespan=lifespan)


class AnalyzeRequest(BaseModel):
    """Request body for `POST /analyze`."""

    model_config = ConfigDict(extra="forbid")

    contractId: str = Field(min_length=1)  # camelCase matches the shared schemas
    # Same 100 KB cap the API puts on uploads.
    source: str = Field(min_length=1, max_length=102_400)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze", response_model=None)
def analyze(request: AnalyzeRequest) -> dict[str, Any] | JSONResponse:
    """Runs Slither on `source` and explains each finding. Nothing is stored.
    Unsupported pragmas and compile errors answer 422 with the reason."""
    settings: Settings = app.state.settings
    source = request.source.encode("utf-8")
    try:
        solc_version = pick_solc(source, settings.supported_solc)
        report = run_slither(source, f"{request.contractId}.sol", solc_version)
    except (UnsupportedSolcError, SlitherError) as err:
        return JSONResponse(status_code=422, content={"detail": str(err)})

    detectors = parse_detectors(report)
    try:
        explained = app.state.explainer.explain(request.source, detectors) if detectors else {}
    except Exception:  # advisory only
        log.exception("explainer raised; falling back to Slither text")
        explained = {}
    findings = [
        {
            "severity": severity_for(d.impact),
            "slitherDetector": d.check,
            "confidence": d.confidence,
            "llmExplanation": without_nul(text),
            "explanationSource": text_source,
            "rawOutput": without_nul(d.raw),
        }
        for d, (text, text_source) in zip(
            detectors, explanations_for(detectors, explained), strict=True
        )
    ]
    return {"contractId": request.contractId, "solcVersion": solc_version, "findings": findings}
