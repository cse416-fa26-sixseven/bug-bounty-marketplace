"""The job poller: claims jobs from the Postgres queue the API writes to and
runs them. It runs in a background thread of the HTTP service (see app.py),
or on its own via the `bbm-analysis-worker` console script."""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
from collections.abc import MutableMapping
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

import psycopg

from .analysis_job import JobOutcome, run_analysis_job
from .config import Settings
from .db import connect
from .jobs import Job, claim_next, expire_exhausted, fail
from .llm import Explainer, make_explainer
from .sandbox_job import run_sandbox_job
from .sandbox_k8s import WAIT_GRACE_S, active_deadline, load_job_template

log = logging.getLogger("analysis.worker")

_DOTENV = Settings.dotenv_path()


def load_dotenv(path: Path, env: MutableMapping[str, str]) -> None:
    """Minimal .env reader: KEY=VALUE lines, `#` comments, optional `export`.
    Values already in `env` win, so real environment variables override."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in env:
            env[key] = value


def handle(job: Job, settings: Settings, explainer: Explainer | None) -> None:
    """Runs one job on its own connection and records any failure. Never
    raises: if the database is unreachable the job's lease expires and it is
    retried, and the error is logged."""
    try:
        _handle(job, settings, explainer)
    except Exception:
        log.exception("job %s could not be run", job.id)


def _handle(job: Job, settings: Settings, explainer: Explainer | None) -> None:
    with connect(settings.database_url) as conn:
        try:
            if job.kind == "analysis":
                outcome = run_analysis_job(conn, job, settings, explainer)
            elif job.kind == "sandbox":
                outcome = run_sandbox_job(conn, job, settings)
            else:
                outcome = JobOutcome(ok=False, reason=f"No handler for {job.kind} jobs")
        except Exception as err:  # a bug or an outage: let the job be retried
            log.exception("job %s crashed", job.id)
            outcome = JobOutcome(ok=False, reason=f"{type(err).__name__}: {err}", retryable=True)
        if not outcome.ok:
            log.warning("job %s (%s) failed: %s", job.id, job.kind, outcome.reason)
            try:
                fail(
                    conn,
                    job,
                    outcome.reason or "unknown error",
                    outcome.retryable,
                    settings.job_max_attempts,
                )
            except Exception:
                # The lease expires and the job is retried; just don't lose it silently.
                log.exception("could not record the failure of job %s", job.id)


# Headroom the job lease needs over the worker's wait for a sandbox Job, so a
# slow run is never re-claimed by another worker and run twice.
_LEASE_HEADROOM_S = 120


def sandbox_startup_warnings(settings: Settings) -> list[str]:
    """Kubernetes-backend settings that work but will bite: a job lease that
    does not outlive the wait for a sandbox Job (the Helm chart guards this
    too). Cheap, so it runs at every start-up; a missing template is reported
    by the first sandbox job, not here."""
    if not (
        settings.sandbox_enabled
        and settings.sandbox_backend == "kubernetes"
        and settings.sandbox_config_error is None
    ):
        return []
    try:
        deadline = active_deadline(load_job_template(settings.sandbox_job_template))
    except ValueError:
        return []
    needed = deadline + _LEASE_HEADROOM_S
    if settings.job_lease_s <= needed:
        return [
            f"JOB_LEASE_SECONDS={settings.job_lease_s} is not above the sandbox Job's"
            f" activeDeadlineSeconds ({deadline}) + {_LEASE_HEADROOM_S}s: a PoC that waits"
            f" {deadline + WAIT_GRACE_S}s for a node could be re-claimed and run twice;"
            f" set it to at least {needed + 1}"
        ]
    return []


def run(settings: Settings, stop: threading.Event, explainer: Explainer | None = None) -> None:
    """Polls until `stop` is set. A database error (e.g. the API has not
    applied its migrations yet) is logged and retried after a pause."""
    explainer = explainer if explainer is not None else make_explainer(settings)
    log.info(
        "worker started (jobs %s, concurrency %d, LLM %s, sandbox backend %s)",
        "/".join(settings.job_kinds),
        settings.worker_concurrency,
        "on" if settings.llm_configured else "off: Slither text only",
        settings.sandbox_backend,
    )
    if settings.sandbox_enabled and settings.sandbox_config_error:
        log.error(
            "sandbox misconfigured, sandbox jobs will fail as infra errors: %s",
            settings.sandbox_config_error,
        )
    for warning in sandbox_startup_warnings(settings):
        log.warning("%s", warning)
    in_flight: set[Future] = set()
    with ThreadPoolExecutor(settings.worker_concurrency) as pool:
        while not stop.is_set():
            try:
                with connect(settings.database_url) as conn:
                    while not stop.is_set():
                        in_flight = {f for f in in_flight if not f.done()}
                        job = None
                        if len(in_flight) < settings.worker_concurrency:
                            expire_exhausted(conn, settings.job_max_attempts)
                            job = claim_next(
                                conn,
                                settings.job_lease_s,
                                settings.job_max_attempts,
                                settings.job_kinds,
                            )
                        if job is None:
                            stop.wait(settings.poll_interval_s)
                            continue
                        log.info(
                            "claimed %s job %s for %s (attempt %d)",
                            job.kind,
                            job.id,
                            job.subject_id,
                            job.attempts,
                        )
                        in_flight.add(pool.submit(handle, job, settings, explainer))
            except psycopg.Error as err:
                log.warning("job queue unavailable, retrying: %s", err)
                stop.wait(settings.poll_interval_s)
        log.info("stopping: waiting for %d running job(s)", len(in_flight))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    load_dotenv(_DOTENV, os.environ)
    settings = Settings.from_env()
    missing = [
        name
        for name, value in (
            ("DATABASE_URL", settings.database_url),
            ("SOURCE_STORAGE_DIR", settings.source_storage_dir),
        )
        if not value
    ]
    if missing:
        sys.exit(f"bbm-analysis-worker: set {', '.join(missing)} (see .env.example)")
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    run(settings, stop)
