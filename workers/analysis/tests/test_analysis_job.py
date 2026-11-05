import json
import re
from pathlib import Path

import pytest

from analysis.analysis_job import run_analysis_job
from analysis.config import Settings
from analysis.generated.models import Finding
from analysis.jobs import claim_next
from analysis.slither_runner import SlitherError

from .conftest import insert_contract

FIXTURES = Path(__file__).parent / "fixtures"
VAULT = (FIXTURES / "Vault.sol").read_bytes()
VAULT_REPORT = json.loads((FIXTURES / "vault-slither.json").read_text())
ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class FakeExplainer:
    def __init__(self, explained: dict[int, str] | None = None) -> None:
        self.explained = explained or {}
        self.calls: list[tuple[str, list]] = []

    def explain(self, source, detectors):
        self.calls.append((source, list(detectors)))
        return self.explained


def _slither(report=VAULT_REPORT, calls=None):
    def run(source, filename, solc_version, timeout_s=120):
        if calls is not None:
            calls.append((source, filename, solc_version))
        return report

    return run


@pytest.fixture
def settings(tmp_path):
    return Settings.from_env({"SOURCE_STORAGE_DIR": str(tmp_path)})


def _claim(pg_conn):
    job = claim_next(pg_conn, 600, 3)
    assert job is not None
    return job


def _findings(pg_conn, contract_id):
    return pg_conn.execute(
        "SELECT * FROM findings WHERE contract_id = %s ORDER BY created_at, id", (contract_id,)
    ).fetchall()


def _to_shared(row) -> dict:
    return {
        "id": row["id"],
        "contractId": row["contract_id"],
        "severity": row["severity"],
        "slitherDetector": row["slither_detector"],
        "rawOutputReference": row["raw_output_reference"],
        "llmExplanation": row["llm_explanation"],
        "status": row["status"],
        "statusHistory": row["status_history"],
        "claimedByAuditorId": None,
        "claimExpiresAt": None,
        "isFalsePositive": row["is_false_positive"],
        "challengeWindowExpiresAt": None,
        # Columns from migration 0009; worker findings default to slither.
        "source": row["source"],
        "title": row["title"],
        "reportedByAuditorId": row["reported_by_auditor_id"],
    }


def test_vault_creates_flagged_findings(pg_conn, settings, tmp_path):
    contract_id = insert_contract(pg_conn, VAULT, tmp_path)
    job = _claim(pg_conn)
    explainer = FakeExplainer({0: "Funds can be drained."})
    slither_calls: list = []

    outcome = run_analysis_job(
        pg_conn, job, settings, explainer, slither=_slither(calls=slither_calls)
    )

    assert outcome.ok
    assert slither_calls == [(VAULT, "Vault.sol", "0.8.28")]
    assert explainer.calls[0][0] == VAULT.decode()
    rows = _findings(pg_conn, contract_id)
    assert [r["slither_detector"] for r in rows] == [
        "reentrancy-eth",
        "solc-version",
        "low-level-calls",
    ]
    for row in rows:
        Finding.model_validate(_to_shared(row))
        assert row["status"] == "Flagged"
        assert row["raw_output_reference"] == f"/api/findings/{row['id']}/raw"
        assert len(row["status_history"]) == 1
        assert row["status_history"][0]["status"] == "Flagged"
        assert ISO_Z.match(row["status_history"][0]["changedAt"])
    assert rows[0]["severity"] == "High"
    assert rows[0]["raw_output"]["check"] == "reentrancy-eth"
    assert (rows[0]["llm_explanation"], rows[0]["explanation_source"]) == (
        "Funds can be drained.",
        "llm",
    )
    assert rows[1]["explanation_source"] == "slither"
    status = pg_conn.execute("SELECT status FROM jobs WHERE id = %s", (job.id,)).fetchone()
    assert status["status"] == "done"


def test_hash_mismatch_fails_without_retry(pg_conn, settings, tmp_path):
    contract_id = insert_contract(pg_conn, VAULT, tmp_path)
    key = pg_conn.execute(
        "SELECT source_reference FROM contracts WHERE id = %s", (contract_id,)
    ).fetchone()["source_reference"]
    (tmp_path / key).write_bytes(VAULT + b"// tampered\n")
    outcome = run_analysis_job(
        pg_conn, _claim(pg_conn), settings, FakeExplainer(), slither=_slither()
    )
    assert not outcome.ok and not outcome.retryable
    assert outcome.reason.startswith("Source hash mismatch")
    assert _findings(pg_conn, contract_id) == []


def test_missing_source_file_fails_without_retry(pg_conn, settings, tmp_path):
    contract_id = insert_contract(pg_conn, VAULT, tmp_path)
    key = pg_conn.execute(
        "SELECT source_reference FROM contracts WHERE id = %s", (contract_id,)
    ).fetchone()["source_reference"]
    (tmp_path / key).unlink()
    outcome = run_analysis_job(
        pg_conn, _claim(pg_conn), settings, FakeExplainer(), slither=_slither()
    )
    assert not outcome.ok and not outcome.retryable
    assert outcome.reason.startswith("Source file not found")


def test_unsupported_pragma_fails_without_retry(pg_conn, settings, tmp_path):
    insert_contract(pg_conn, b"pragma solidity ^0.6.0;\ncontract Old {}\n", tmp_path)
    outcome = run_analysis_job(
        pg_conn, _claim(pg_conn), settings, FakeExplainer(), slither=_slither()
    )
    assert (outcome.ok, outcome.retryable, outcome.reason) == (
        False,
        False,
        "Unsupported Solidity version: ^0.6.0",
    )


def test_slither_error_fails_without_retry(pg_conn, settings, tmp_path):
    insert_contract(pg_conn, VAULT, tmp_path)

    def broken(*args, **kwargs):
        raise SlitherError("ParserError: Expected ';'")

    outcome = run_analysis_job(pg_conn, _claim(pg_conn), settings, FakeExplainer(), slither=broken)
    assert (outcome.ok, outcome.retryable, outcome.reason) == (
        False,
        False,
        "ParserError: Expected ';'",
    )


def test_zero_findings_is_done(pg_conn, settings, tmp_path):
    contract_id = insert_contract(pg_conn, VAULT, tmp_path)
    job = _claim(pg_conn)
    explainer = FakeExplainer()
    outcome = run_analysis_job(
        pg_conn, job, settings, explainer, slither=_slither({"success": True, "results": {}})
    )
    assert outcome.ok
    assert _findings(pg_conn, contract_id) == []
    assert explainer.calls == [] or explainer.calls[0][1] == []
    assert (
        pg_conn.execute("SELECT status FROM jobs WHERE id = %s", (job.id,)).fetchone()["status"]
        == "done"
    )


def test_llm_failure_still_creates_findings(pg_conn, settings, tmp_path):
    contract_id = insert_contract(pg_conn, VAULT, tmp_path)

    class Exploding:
        def explain(self, source, detectors):
            raise RuntimeError("explainer bug")

    outcome = run_analysis_job(pg_conn, _claim(pg_conn), settings, Exploding(), slither=_slither())
    assert outcome.ok
    rows = _findings(pg_conn, contract_id)
    assert rows and all(r["explanation_source"] == "slither" for r in rows)


def test_contract_row_missing_fails_without_retry(pg_conn, settings):
    from .conftest import insert_job

    insert_job(pg_conn, "analysis", "contract_gone")
    outcome = run_analysis_job(
        pg_conn, _claim(pg_conn), settings, FakeExplainer(), slither=_slither()
    )
    assert (outcome.ok, outcome.retryable) == (False, False)
    assert outcome.reason == "Contract contract_gone not found"


def test_nul_characters_in_slither_output_are_stored_safely(pg_conn, settings, tmp_path):
    contract_id = insert_contract(pg_conn, VAULT, tmp_path)
    report = {
        "success": True,
        "results": {
            "detectors": [
                {
                    "check": "low-level-calls",
                    "impact": "Informational",
                    "confidence": "High",
                    "description": 'Low level call a.call("\x00abc")\n',
                    "elements": [{"name": "\x00abc", "nested": ["x\x00y"]}],
                }
            ]
        },
    }
    outcome = run_analysis_job(
        pg_conn, _claim(pg_conn), settings, FakeExplainer(), slither=_slither(report)
    )
    assert outcome.ok, outcome.reason
    row = _findings(pg_conn, contract_id)[0]
    assert "\x00" not in row["llm_explanation"]
    assert "\\0abc" in row["llm_explanation"]
    assert row["raw_output"]["elements"][0] == {"name": "\\0abc", "nested": ["x\\0y"]}


def test_no_transaction_is_held_open_while_slither_runs(pg_conn, settings, tmp_path):
    from psycopg.pq import TransactionStatus

    insert_contract(pg_conn, VAULT, tmp_path)
    seen = []

    def slither(source, filename, solc_version, timeout_s=120):
        # An open transaction here would hold a lock on contracts for the whole
        # Slither + LLM run and block the API's migrations on reboot.
        seen.append(pg_conn.info.transaction_status)
        return VAULT_REPORT

    assert run_analysis_job(pg_conn, _claim(pg_conn), settings, FakeExplainer(), slither=slither).ok
    assert seen == [TransactionStatus.IDLE]
