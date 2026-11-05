"""Analysis jobs: Slither on the submitted contract, LLM explanations, and
Flagged findings written back to Postgres."""

from __future__ import annotations

import hashlib
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .config import Settings
from .findings import DetectorResult, parse_detectors, severity_for
from .generated.models import Finding
from .jobs import Job, complete
from .llm import Explainer, explanations_for
from .pgsafe import without_nul
from .schema_base import to_iso_z
from .slither_runner import SlitherError, run_slither
from .solc import UnsupportedSolcError, pick_solc
from .storage import SourceStore, open_store

log = logging.getLogger(__name__)

SlitherFn = Callable[..., dict[str, Any]]


@dataclass(frozen=True)
class JobOutcome:
    ok: bool
    reason: str | None = None
    retryable: bool = False


NO_STORAGE = (
    "No source storage configured (SOURCE_STORAGE_BLOB_CONTAINER_URL or SOURCE_STORAGE_DIR)"
)


def _final(reason: str) -> JobOutcome:
    return JobOutcome(ok=False, reason=reason, retryable=False)


def _explain(explainer: Explainer, source: bytes, detectors: list[DetectorResult]):
    try:
        explained = explainer.explain(source.decode("utf-8", errors="replace"), detectors)
    except Exception:  # advisory only: never let the LLM fail the job
        log.exception("explainer raised; falling back to Slither text")
        explained = {}
    return explanations_for(detectors, explained)


def run_analysis_job(
    conn: psycopg.Connection,
    job: Job,
    settings: Settings,
    explainer: Explainer,
    slither: SlitherFn = run_slither,
    store: SourceStore | None = None,
) -> JobOutcome:
    """Analyses one contract. On success, writes its findings and marks the job
    done in one transaction. On failure, returns the outcome for the caller
    to record with jobs.fail(); nothing has been written. `store` defaults to
    the one the settings select."""
    contract = conn.execute(
        "SELECT filename, source_hash, source_reference FROM contracts WHERE id = %s",
        (job.subject_id,),
    ).fetchone()
    # End the read transaction now: holding it through Slither and the LLM
    # would keep a lock on contracts for minutes.
    conn.commit()
    if contract is None:
        return _final(f"Contract {job.subject_id} not found")
    store = store if store is not None else open_store(settings)
    if store is None:
        return JobOutcome(ok=False, reason=NO_STORAGE, retryable=True)

    key = contract["source_reference"]
    try:
        source = store.read(key)
    except FileNotFoundError:
        return _final(f"Source file not found: {key}")
    if hashlib.sha256(source).hexdigest() != contract["source_hash"]:
        return _final(f"Source hash mismatch for {key}")

    try:
        solc_version = pick_solc(source, settings.supported_solc)
        report = slither(source, contract["filename"], solc_version)
    except (UnsupportedSolcError, SlitherError) as err:
        return _final(str(err))

    detectors = [
        replace(d, description=without_nul(d.description), raw=without_nul(d.raw))
        for d in parse_detectors(report)
    ]
    texts = _explain(explainer, source, detectors) if detectors else []

    now = datetime.now(UTC)
    for detector, (raw_text, text_source) in zip(detectors, texts, strict=True):
        text = without_nul(raw_text)
        finding_id = f"finding_{uuid.uuid4()}"
        reference = f"/api/findings/{finding_id}/raw"
        history = [{"status": "Flagged", "changedAt": to_iso_z(now)}]
        # Validate against the shared schema before writing, so a mapping bug
        # fails here instead of breaking the API's response parsing.
        Finding.model_validate(
            {
                "id": finding_id,
                "contractId": job.subject_id,
                "severity": severity_for(detector.impact),
                "slitherDetector": detector.check,
                "rawOutputReference": reference,
                "llmExplanation": text,
                "status": "Flagged",
                "statusHistory": history,
                "claimedByAuditorId": None,
                "claimExpiresAt": None,
                "isFalsePositive": False,
                "challengeWindowExpiresAt": None,
                # The findings.source column defaults to 'slither'.
                "source": "slither",
                "title": None,
                "reportedByAuditorId": None,
                "developerNote": None,
                "developerNoteUpdatedAt": None,
            }
        )
        conn.execute(
            "INSERT INTO findings (id, contract_id, severity, slither_detector, slither_confidence,"
            " raw_output, raw_output_reference, llm_explanation, explanation_source, status,"
            " status_history, created_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'Flagged', %s, %s)",
            (
                finding_id,
                job.subject_id,
                severity_for(detector.impact),
                without_nul(detector.check),
                without_nul(detector.confidence),
                Jsonb(detector.raw),
                reference,
                text,
                text_source,
                Jsonb(history),
                # Keep Slither's order among findings of equal severity.
                now + timedelta(microseconds=detector.index),
            ),
        )
    complete(conn, job.id)
    conn.commit()
    log.info("analysed %s: %d findings (solc %s)", job.subject_id, len(detectors), solc_version)
    return JobOutcome(ok=True)
