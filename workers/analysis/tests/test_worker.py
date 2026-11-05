from pathlib import Path

from analysis import worker as main
from analysis.config import Settings
from analysis.jobs import claim_next
from analysis.storage import read_source

from .conftest import insert_job


def _settings(tmp_path, database_url):
    return Settings.from_env({"DATABASE_URL": database_url, "SOURCE_STORAGE_DIR": str(tmp_path)})


def test_handle_turns_an_unexpected_exception_into_a_retryable_fail(
    pg_conn, tmp_path, monkeypatch, test_database_url
):
    insert_job(pg_conn, "analysis", "contract_a")
    job = claim_next(pg_conn, 600, 3)

    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(main, "run_analysis_job", boom)
    main.handle(job, _settings(tmp_path, test_database_url), explainer=None)
    row = pg_conn.execute("SELECT status, last_error FROM jobs WHERE id = %s", (job.id,)).fetchone()
    assert (row["status"], row["last_error"]) == ("queued", "RuntimeError: boom")


def test_load_dotenv_sets_missing_values_only(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text("# comment\nA=1\nB = two words \nEMPTY=\nexport C=3\nnot a pair\n")
    env = {"A": "keep"}
    main.load_dotenv(env_file, env)
    assert env == {"A": "keep", "B": "two words", "EMPTY": "", "C": "3"}


def test_load_dotenv_ignores_a_missing_file(tmp_path: Path):
    env: dict[str, str] = {}
    main.load_dotenv(tmp_path / "nope.env", env)
    assert env == {}


def test_read_source_refuses_keys_outside_the_root(tmp_path: Path):
    import pytest

    (tmp_path / "contracts").mkdir()
    (tmp_path / "contracts" / "a.sol").write_bytes(b"x")
    assert read_source(tmp_path, "contracts/a.sol") == b"x"
    with pytest.raises(ValueError):
        read_source(tmp_path, "../outside.sol")


def test_settings_claim_sandbox_jobs_only_when_enabled():
    assert Settings.from_env({}).job_kinds == ("analysis",)
    assert Settings.from_env({"SANDBOX_ENABLED": "true"}).job_kinds == ("analysis", "sandbox")


def test_run_keeps_polling_after_a_database_error(monkeypatch, tmp_path):
    import threading

    import psycopg

    calls = []
    stop = threading.Event()

    def flaky_claim(conn, lease_s, max_attempts, kinds):
        calls.append(kinds)
        if len(calls) == 1:
            raise psycopg.OperationalError('relation "jobs" does not exist')
        stop.set()
        return None

    class FakeConn:
        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(main, "connect", lambda url: FakeConn())
    monkeypatch.setattr(main, "claim_next", flaky_claim)
    monkeypatch.setattr(main, "expire_exhausted", lambda conn, max_attempts: 0)
    settings = Settings.from_env(
        {
            "DATABASE_URL": "postgres://x",
            "SOURCE_STORAGE_DIR": str(tmp_path),
            "POLL_INTERVAL_SECONDS": "0.01",
        }
    )
    main.run(settings, stop)
    assert calls == [("analysis",), ("analysis",)]


def test_handle_never_raises_when_recording_the_failure_fails(
    pg_conn, tmp_path, monkeypatch, test_database_url, caplog
):
    import logging

    import psycopg

    insert_job(pg_conn, "analysis", "contract_a")
    job = claim_next(pg_conn, 600, 3)

    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    def broken_fail(*args, **kwargs):
        raise psycopg.OperationalError("connection lost")

    monkeypatch.setattr(main, "run_analysis_job", boom)
    monkeypatch.setattr(main, "fail", broken_fail)
    with caplog.at_level(logging.ERROR, logger="analysis"):
        main.handle(job, _settings(tmp_path, test_database_url), explainer=None)
    assert "could not record" in caplog.text


def test_load_dotenv_strips_matching_quotes(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text('A="quoted value"\nB=\'single\'\nC="unbalanced\n')
    env: dict[str, str] = {}
    main.load_dotenv(env_file, env)
    assert env == {"A": "quoted value", "B": "single", "C": '"unbalanced'}


def test_handle_dispatches_sandbox_jobs(pg_conn, tmp_path, monkeypatch, test_database_url):
    from analysis.analysis_job import JobOutcome

    insert_job(pg_conn, "sandbox", "poc_a")
    job = claim_next(pg_conn, 600, 3)
    seen = []

    def fake(conn, job, settings):
        seen.append(job.subject_id)
        return JobOutcome(ok=False, reason="Docker CLI not found", retryable=True)

    monkeypatch.setattr(main, "run_sandbox_job", fake)
    main.handle(job, _settings(tmp_path, test_database_url), explainer=None)
    assert seen == ["poc_a"]
    row = pg_conn.execute("SELECT status, last_error FROM jobs WHERE id = %s", (job.id,)).fetchone()
    assert (row["status"], row["last_error"]) == ("queued", "Docker CLI not found")


def test_sandbox_startup_warns_when_the_lease_cannot_outlive_the_job_wait(tmp_path: Path):
    template = tmp_path / "job.yaml"
    template.write_text(
        "kind: Job\nspec:\n  activeDeadlineSeconds: 600\n  template:\n    spec:\n"
        "      containers: [{name: poc}]\n      volumes: [{name: project, secret: {}}]\n"
    )
    base = {
        "SANDBOX_ENABLED": "true",
        "SANDBOX_BACKEND": "kubernetes",
        "SANDBOX_NAMESPACE": "bbm-sandbox",
        "SANDBOX_JOB_TEMPLATE": str(template),
    }
    short = main.sandbox_startup_warnings(Settings.from_env({**base, "JOB_LEASE_SECONDS": "720"}))
    assert len(short) == 1
    assert "JOB_LEASE_SECONDS=720" in short[0] and "activeDeadlineSeconds (600)" in short[0]
    assert "at least 721" in short[0]
    assert (
        main.sandbox_startup_warnings(Settings.from_env({**base, "JOB_LEASE_SECONDS": "900"})) == []
    )
    # Not the kubernetes backend, sandbox off, or a template the first job will report: quiet.
    assert (
        main.sandbox_startup_warnings(Settings.from_env({**base, "SANDBOX_BACKEND": "docker"}))
        == []
    )
    assert main.sandbox_startup_warnings(Settings.from_env({**base, "SANDBOX_ENABLED": ""})) == []
    missing = {**base, "SANDBOX_JOB_TEMPLATE": str(tmp_path / "nope.yaml")}
    assert main.sandbox_startup_warnings(Settings.from_env(missing)) == []
