import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from analysis.config import Settings
from analysis.jobs import claim_next
from analysis.sandbox import SandboxResult, run_poc
from analysis.sandbox_job import pick_runner, run_sandbox_job
from analysis.sandbox_k8s import run_poc_k8s

from .conftest import insert_contract, insert_finding, insert_job

FIXTURES = Path(__file__).parent / "fixtures"
VAULT = (FIXTURES / "Vault.sol").read_bytes()
POC = (FIXTURES / "pocs" / "PoC_pass.t.sol").read_bytes()


@pytest.fixture
def settings(tmp_path):
    return Settings.from_env({"SOURCE_STORAGE_DIR": str(tmp_path)})


def _submitted_poc(pg_conn, tmp_path, poc_bytes=POC):
    """A contract with a Submitted finding and a Pending PoC, as the API leaves them."""
    contract_id = insert_contract(pg_conn, VAULT, tmp_path, queue_job=False)
    finding_id = insert_finding(pg_conn, contract_id, status="Flagged")
    poc_id = f"poc_{uuid.uuid4()}"
    key = f"pocs/{poc_id}/{hashlib.sha256(poc_bytes).hexdigest()}.t.sol"
    (tmp_path / key).parent.mkdir(parents=True)
    (tmp_path / key).write_bytes(poc_bytes)
    now = datetime.now(UTC)
    pg_conn.execute(
        "UPDATE findings SET status = 'Submitted',"
        " status_history = status_history || jsonb_build_array(jsonb_build_object("
        "'status', 'Submitted', 'changedAt', '2026-10-20T12:00:00.000Z'))"
        " WHERE id = %s",
        (finding_id,),
    )
    pg_conn.execute(
        "INSERT INTO poc_submissions (id, finding_id, auditor_id, test_file_reference,"
        " submitted_at, sandbox_status) VALUES (%s, %s, 'auditor_1', %s, %s, 'Pending')",
        (poc_id, finding_id, key, now),
    )
    pg_conn.commit()
    insert_job(pg_conn, "sandbox", poc_id)
    return finding_id, poc_id


class FakeRunner:
    def __init__(self, result: SandboxResult):
        self.result = result
        self.calls: list[tuple[bytes, str]] = []

    def __call__(self, tar, poc_id, settings):
        self.calls.append((tar, poc_id))
        return self.result


def _row(pg_conn, table, row_id):
    return pg_conn.execute(f"SELECT * FROM {table} WHERE id = %s", (row_id,)).fetchone()


def test_passed_poc_verifies_the_finding_and_opens_the_challenge_window(
    pg_conn, tmp_path, settings
):
    finding_id, poc_id = _submitted_poc(pg_conn, tmp_path)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status="Passed", log="Suite result: ok.", infra_error=None))

    outcome = run_sandbox_job(pg_conn, job, settings, runner=runner)

    assert outcome.ok
    assert runner.calls[0][1] == poc_id
    poc = _row(pg_conn, "poc_submissions", poc_id)
    assert (poc["sandbox_status"], poc["sandbox_log"]) == ("Passed", "Suite result: ok.")
    finding = _row(pg_conn, "findings", finding_id)
    assert finding["status"] == "Verified"
    assert [h["status"] for h in finding["status_history"]] == ["Flagged", "Submitted", "Verified"]
    expected = datetime.now(UTC) + timedelta(seconds=86400)
    assert abs((finding["challenge_window_expires_at"] - expected).total_seconds()) < 30
    assert _row(pg_conn, "jobs", job.id)["status"] == "done"


def test_failed_poc_rejects_the_finding(pg_conn, tmp_path, settings):
    finding_id, poc_id = _submitted_poc(pg_conn, tmp_path)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(
        SandboxResult(status="Failed", log="Timed out after 120s", infra_error=None)
    )

    assert run_sandbox_job(pg_conn, job, settings, runner=runner).ok

    assert _row(pg_conn, "poc_submissions", poc_id)["sandbox_status"] == "Failed"
    finding = _row(pg_conn, "findings", finding_id)
    assert finding["status"] == "Rejected"
    assert finding["status_history"][-1]["status"] == "Rejected"
    assert finding["challenge_window_expires_at"] is None


def test_infra_error_is_retryable_and_leaves_the_finding_submitted(pg_conn, tmp_path, settings):
    finding_id, poc_id = _submitted_poc(pg_conn, tmp_path)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status=None, log="", infra_error="Docker CLI not found"))

    outcome = run_sandbox_job(pg_conn, job, settings, runner=runner)

    assert (outcome.ok, outcome.retryable, outcome.reason) == (False, True, "Docker CLI not found")
    pg_conn.rollback()
    assert _row(pg_conn, "findings", finding_id)["status"] == "Submitted"
    assert _row(pg_conn, "poc_submissions", poc_id)["sandbox_status"] == "Pending"


def test_tarball_carries_the_stored_contract_and_poc(pg_conn, tmp_path, settings):
    import io
    import tarfile

    _submitted_poc(pg_conn, tmp_path)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status="Passed", log="", infra_error=None))
    run_sandbox_job(pg_conn, job, settings, runner=runner)

    with tarfile.open(fileobj=io.BytesIO(runner.calls[0][0])) as archive:
        assert archive.extractfile("src/Vault.sol").read() == VAULT
        assert archive.extractfile("test/PoC.t.sol").read() == POC
        assert (
            'solc = "/opt/solc/solc-0.8.28"' in archive.extractfile("foundry.toml").read().decode()
        )


def test_already_resolved_poc_is_not_rerun(pg_conn, tmp_path, settings):
    _, poc_id = _submitted_poc(pg_conn, tmp_path)
    pg_conn.execute("UPDATE poc_submissions SET sandbox_status = 'Passed' WHERE id = %s", (poc_id,))
    pg_conn.commit()
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status="Failed", log="", infra_error=None))

    assert run_sandbox_job(pg_conn, job, settings, runner=runner).ok
    assert runner.calls == []
    assert _row(pg_conn, "jobs", job.id)["status"] == "done"


def test_unknown_poc_fails_without_retry(pg_conn, settings):
    insert_job(pg_conn, "sandbox", "poc_missing")
    job = claim_next(pg_conn, 600, 3)
    outcome = run_sandbox_job(pg_conn, job, settings, runner=FakeRunner(None))
    assert (outcome.ok, outcome.retryable, outcome.reason) == (
        False,
        False,
        "PoC poc_missing not found",
    )


def test_nul_in_sandbox_log_is_stored_safely(pg_conn, tmp_path, settings):
    _, poc_id = _submitted_poc(pg_conn, tmp_path)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status="Failed", log="revert\x00data", infra_error=None))
    assert run_sandbox_job(pg_conn, job, settings, runner=runner).ok
    assert _row(pg_conn, "poc_submissions", poc_id)["sandbox_log"] == "revert\\0data"


def test_no_transaction_is_held_open_while_the_poc_runs(pg_conn, tmp_path, settings):
    from psycopg.pq import TransactionStatus

    _submitted_poc(pg_conn, tmp_path)
    job = claim_next(pg_conn, 600, 3)
    seen = []

    def runner(tar, poc_id, settings):
        seen.append(pg_conn.info.transaction_status)
        return SandboxResult(status="Passed", log="", infra_error=None)

    assert run_sandbox_job(pg_conn, job, settings, runner=runner).ok
    assert seen == [TransactionStatus.IDLE]


def test_poc_pragma_compatible_with_the_target_picks_a_shared_compiler(pg_conn, tmp_path, settings):
    import io
    import tarfile

    poc = POC.replace(b"pragma solidity ^0.8.19;", b"pragma solidity 0.8.20;")
    _submitted_poc(pg_conn, tmp_path, poc_bytes=poc)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status="Passed", log="", infra_error=None))
    assert run_sandbox_job(pg_conn, job, settings, runner=runner).ok
    with tarfile.open(fileobj=io.BytesIO(runner.calls[0][0])) as archive:
        toml = archive.extractfile("foundry.toml").read().decode()
    assert 'solc = "/opt/solc/solc-0.8.20"' in toml


def test_poc_pragma_incompatible_with_the_target_rejects_it_with_a_reason(
    pg_conn, tmp_path, settings
):
    poc = POC.replace(b"pragma solidity ^0.8.19;", b"pragma solidity ^0.7.0;")
    finding_id, poc_id = _submitted_poc(pg_conn, tmp_path, poc_bytes=poc)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status="Passed", log="", infra_error=None))
    assert run_sandbox_job(pg_conn, job, settings, runner=runner).ok
    assert runner.calls == []
    stored = _row(pg_conn, "poc_submissions", poc_id)
    assert stored["sandbox_status"] == "Failed"
    assert "No supported Solidity version satisfies all of" in stored["sandbox_log"]
    assert _row(pg_conn, "findings", finding_id)["status"] == "Rejected"


@pytest.mark.parametrize("status", ["Passed", "Failed"])
def test_chain_enabled_records_the_result_only(pg_conn, tmp_path, status):
    """With a chain, the API applies the verdict on-chain; the worker leaves the finding alone."""
    settings = Settings.from_env({"SOURCE_STORAGE_DIR": str(tmp_path), "CHAIN_ENABLED": "true"})
    finding_id, poc_id = _submitted_poc(pg_conn, tmp_path)
    before = _row(pg_conn, "findings", finding_id)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status=status, log="log", infra_error=None))

    assert run_sandbox_job(pg_conn, job, settings, runner=runner).ok

    assert _row(pg_conn, "poc_submissions", poc_id)["sandbox_status"] == status
    finding = _row(pg_conn, "findings", finding_id)
    assert finding["status"] == "Submitted"
    assert finding["status_history"] == before["status_history"]
    assert finding["challenge_window_expires_at"] is None
    assert _row(pg_conn, "jobs", job.id)["status"] == "done"


def test_runner_is_picked_from_the_backend_setting():
    assert pick_runner(Settings.from_env({})) is run_poc
    assert pick_runner(Settings.from_env({"SANDBOX_BACKEND": "docker"})) is run_poc
    k8s = Settings.from_env({"SANDBOX_BACKEND": "kubernetes", "SANDBOX_NAMESPACE": "bbm-sandbox"})
    assert pick_runner(k8s) is run_poc_k8s


def test_misconfigured_sandbox_fails_the_job_as_a_retryable_infra_error(pg_conn, tmp_path):
    # SANDBOX_BACKEND=kubernetes without a namespace: a deployment bug, not a
    # bad PoC. The PoC stays Pending and the finding Submitted.
    settings = Settings.from_env(
        {"SOURCE_STORAGE_DIR": str(tmp_path), "SANDBOX_BACKEND": "kubernetes"}
    )
    finding_id, poc_id = _submitted_poc(pg_conn, tmp_path)
    job = claim_next(pg_conn, 600, 3)
    runner = FakeRunner(SandboxResult(status="Passed", log="", infra_error=None))

    outcome = run_sandbox_job(pg_conn, job, settings, runner=runner)

    assert (outcome.ok, outcome.retryable) == (False, True)
    assert outcome.reason == "SANDBOX_BACKEND=kubernetes needs SANDBOX_NAMESPACE"
    assert runner.calls == []
    pg_conn.rollback()
    assert _row(pg_conn, "findings", finding_id)["status"] == "Submitted"
    assert _row(pg_conn, "poc_submissions", poc_id)["sandbox_status"] == "Pending"
