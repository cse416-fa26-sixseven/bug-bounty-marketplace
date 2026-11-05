"""Sandbox jobs: re-run a submitted PoC and record the verdict.

Passed → PoC Passed, finding Verified, challenge window opens.
Failed → PoC Failed, finding Rejected.
Sandbox outage → retried; the finding stays Submitted.
With CHAIN_ENABLED only the PoC's result is recorded: the API applies the
verdict on-chain and then moves the finding.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import psycopg
from psycopg.types.json import Jsonb

from .analysis_job import NO_STORAGE, JobOutcome
from .config import Settings
from .jobs import Job, complete
from .pgsafe import without_nul
from .sandbox import SandboxResult, build_tarball, run_poc
from .schema_base import to_iso_z
from .solc import UnsupportedSolcError, pick_solc_for_all
from .storage import SourceStore, open_store

log = logging.getLogger(__name__)

PocRunner = Callable[[bytes, str, Settings], SandboxResult]

_LOAD = """
SELECT p.id, p.test_file_reference, p.sandbox_status, f.id AS finding_id,
       c.filename, c.source_reference
  FROM poc_submissions p
  JOIN findings f ON f.id = p.finding_id
  JOIN contracts c ON c.id = f.contract_id
 WHERE p.id = %s
"""


def run_sandbox_job(
    conn: psycopg.Connection,
    job: Job,
    settings: Settings,
    runner: PocRunner = run_poc,
    store: SourceStore | None = None,
) -> JobOutcome:
    row = conn.execute(_LOAD, (job.subject_id,)).fetchone()
    # Don't hold the read transaction through a Docker run of up to minutes.
    conn.commit()
    if row is None:
        return JobOutcome(ok=False, reason=f"PoC {job.subject_id} not found")
    if row["sandbox_status"] != "Pending":
        # A retry of a job whose result was already recorded: nothing to do.
        complete(conn, job.id)
        conn.commit()
        return JobOutcome(ok=True)
    store = store if store is not None else open_store(settings)
    if store is None:
        return JobOutcome(ok=False, reason=NO_STORAGE, retryable=True)

    try:
        target = store.read(row["source_reference"])
        poc = store.read(row["test_file_reference"])
    except FileNotFoundError as err:
        return JobOutcome(ok=False, reason=f"Stored file missing: {err.filename}")
    try:
        # A compiler both the contract and the PoC accept (PoCs often pin one).
        solc_version = pick_solc_for_all([target, poc], settings.supported_solc)
    except UnsupportedSolcError as err:
        # The PoC's pragma can't be met alongside the contract's: the PoC
        # can't compile here, which is a failed PoC, not an outage.
        result = SandboxResult(status="Failed", log=str(err), infra_error=None)
    else:
        tar = build_tarball(row["filename"], target, poc, solc_version)
        result = runner(tar, row["id"], settings)
    if result.status is None:
        return JobOutcome(ok=False, reason=result.infra_error, retryable=True)

    now = datetime.now(UTC)
    verified = result.status == "Passed"
    finding_status = "Verified" if verified else "Rejected"
    conn.execute(
        "UPDATE poc_submissions SET sandbox_status = %s, sandbox_log = %s WHERE id = %s",
        (result.status, without_nul(result.log), row["id"]),
    )
    if settings.chain_enabled:
        # The API records the verification on-chain, then moves the finding.
        complete(conn, job.id)
        conn.commit()
        log.info(
            "PoC %s: %s (finding %s left for the API)", row["id"], result.status, row["finding_id"]
        )
        return JobOutcome(ok=True)
    conn.execute(
        "UPDATE findings SET status = %s,"
        " status_history = status_history || %s,"
        " challenge_window_expires_at = %s"
        " WHERE id = %s AND status = 'Submitted'",
        (
            finding_status,
            Jsonb([{"status": finding_status, "changedAt": to_iso_z(now)}]),
            now + timedelta(seconds=settings.challenge_window_s) if verified else None,
            row["finding_id"],
        ),
    )
    complete(conn, job.id)
    conn.commit()
    log.info(
        "PoC %s: %s → finding %s %s", row["id"], result.status, row["finding_id"], finding_status
    )
    return JobOutcome(ok=True)
