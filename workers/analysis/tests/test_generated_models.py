from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from analysis.generated.models import Contract, Dispute, Finding, FindingStatus, Severity

VALID_FINDING = {
    "id": "finding-1",
    "contractId": "contract-1",
    "severity": "High",
    "slitherDetector": "reentrancy-eth",
    "rawOutputReference": "slither/contract-1.json",
    "llmExplanation": "External call before state update allows re-entrancy.",
    "status": "Flagged",
    "statusHistory": [{"status": "Flagged", "changedAt": "2026-01-01T00:00:00Z"}],
    "claimedByAuditorId": None,
    "claimExpiresAt": None,
    "isFalsePositive": False,
    "challengeWindowExpiresAt": "2026-01-08T00:00:00Z",
    "source": "slither",
    "title": None,
    "reportedByAuditorId": None,
}


def test_auditor_reported_finding_validates() -> None:
    finding = Finding.model_validate(
        {
            **VALID_FINDING,
            "source": "auditor",
            "title": "Unprotected sweep()",
            "reportedByAuditorId": "auditor-1",
        }
    )
    assert finding.source == "auditor"
    with pytest.raises(ValidationError):
        Finding.model_validate({**VALID_FINDING, "source": "llm"})


def test_finding_round_trips() -> None:
    finding = Finding.model_validate(VALID_FINDING)
    assert finding.severity is Severity.High
    assert isinstance(finding.status, FindingStatus)
    assert finding.status is FindingStatus.Flagged
    assert isinstance(finding.statusHistory[0].status, FindingStatus)
    assert finding.statusHistory[0].changedAt.tzinfo is not None
    assert finding.model_dump(mode="json")["slitherDetector"] == "reentrancy-eth"


def test_finding_rejects_unknown_severity() -> None:
    with pytest.raises(ValidationError):
        Finding.model_validate({**VALID_FINDING, "severity": "Catastrophic"})


def test_finding_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        Finding.model_validate({**VALID_FINDING, "payout": 100})


def test_finding_rejects_naive_datetime() -> None:
    with pytest.raises(ValidationError):
        Finding.model_validate({**VALID_FINDING, "challengeWindowExpiresAt": "2026-01-08T00:00:00"})


def test_contract_model_exists() -> None:
    assert "sourceHash" in Contract.model_fields


def test_finding_dumps_utc_with_z_and_millis() -> None:
    dumped = Finding.model_validate(VALID_FINDING).model_dump(mode="json")
    assert dumped["challengeWindowExpiresAt"] == "2026-01-08T00:00:00.000Z"
    assert dumped["statusHistory"][0]["changedAt"] == "2026-01-01T00:00:00.000Z"
    assert dumped["claimExpiresAt"] is None


def test_offset_datetime_is_normalised_to_utc() -> None:
    finding = Finding.model_validate(
        {**VALID_FINDING, "challengeWindowExpiresAt": "2026-01-08T05:30:00.123456+05:00"}
    )
    stored = finding.challengeWindowExpiresAt
    assert stored is not None
    assert stored.utcoffset() == timedelta(0)
    assert stored == datetime(2026, 1, 8, 0, 30, 0, 123456, tzinfo=UTC)
    assert finding.model_dump_json().count("+05:00") == 0
    assert finding.model_dump(mode="json")["challengeWindowExpiresAt"] == "2026-01-08T00:30:00.123Z"


def test_offset_datetime_object_is_normalised_to_utc() -> None:
    plus5 = timezone(timedelta(hours=5))
    finding = Finding.model_validate(
        {**VALID_FINDING, "claimExpiresAt": datetime(2026, 1, 8, 5, 0, tzinfo=plus5)}
    )
    assert finding.claimExpiresAt == datetime(2026, 1, 8, 0, 0, tzinfo=UTC)
    assert finding.claimExpiresAt is not None
    assert finding.claimExpiresAt.tzinfo is UTC
    assert finding.model_dump(mode="json")["claimExpiresAt"] == "2026-01-08T00:00:00.000Z"


def test_naive_datetime_object_rejected() -> None:
    with pytest.raises(ValidationError):
        Finding.model_validate({**VALID_FINDING, "claimExpiresAt": datetime(2026, 1, 8)})


def test_claimed_by_auditor_id_is_plain_str() -> None:
    finding = Finding.model_validate({**VALID_FINDING, "claimedByAuditorId": "auditor-1"})
    assert type(finding.claimedByAuditorId) is str
    assert finding.claimedByAuditorId == "auditor-1"
    with pytest.raises(ValidationError):
        Finding.model_validate({**VALID_FINDING, "claimedByAuditorId": ""})


def test_dispute_arbiter_id_is_plain_str_or_none() -> None:
    base = {
        "id": "dispute-1",
        "findingId": "finding-1",
        "developerId": "dev-1",
        "reason": "Not exploitable",
        "openedAt": "2026-01-01T00:00:00Z",
        "challengeWindowExpiresAt": "2026-01-08T00:00:00Z",
        "ruling": "Pending",
        "ruledAt": None,
        "arbiterId": None,
    }
    assert Dispute.model_validate(base).arbiterId is None
    dispute = Dispute.model_validate({**base, "arbiterId": "arb-1"})
    assert type(dispute.arbiterId) is str
