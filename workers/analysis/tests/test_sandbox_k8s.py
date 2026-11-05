"""The Kubernetes sandbox backend against an in-memory fake API (no sockets:
pytest runs with --disable-socket). The verdict rules are the Docker
backend's; what is tested here is the Job/Secret choreography around them."""

from __future__ import annotations

import base64
from pathlib import Path

import pytest
import yaml

from analysis.config import Settings
from analysis.sandbox import LOG_LIMIT_BYTES, STARTED_MARKER, SandboxResult
from analysis.sandbox_k8s import (
    DELETE_WAIT_S,
    MAX_TAR_BYTES,
    POLL_INTERVAL_S,
    WAIT_GRACE_S,
    KubeApiError,
    KubernetesApi,
    build_job,
    job_name,
    load_job_template,
    run_poc_k8s,
)

NS = "bbm-sandbox"
IMAGE = "bbmacr.azurecr.io/bbm/sandbox:sha-1234567"

# The §4.2 contract as the Helm chart renders it (only the fields the
# runner touches plus the ones it reads).
TEMPLATE = """
apiVersion: batch/v1
kind: Job
metadata:
  generateName: sandbox-run-
  namespace: wrong-namespace
  labels:
    app.kubernetes.io/part-of: bbm
    app.kubernetes.io/component: sandbox-run
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 600
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      runtimeClassName: kata-vm-isolation
      automountServiceAccountToken: false
      enableServiceLinks: false
      nodeSelector:
        bbm.io/pool: sandbox
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
      containers:
        - name: run
          image: REPLACED_BY_RUNNER
          resources:
            limits: {cpu: "1", memory: 1Gi, ephemeral-storage: 1Gi}
          securityContext:
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
          volumeMounts:
            - {name: tmp, mountPath: /tmp}
            - {name: project, mountPath: /in, readOnly: true}
      volumes:
        - name: tmp
          emptyDir: {sizeLimit: 256Mi}
        - name: project
          secret: {secretName: REPLACED_BY_RUNNER}
"""

PASS_OUTPUT = (
    f"{STARTED_MARKER}\n"
    "Ran 1 test for test/PoC.t.sol:PoCTest\n"
    "[PASS] test_reentrancyDrainsVault() (gas: 1)\n"
    "Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 1ms\n"
)
FAIL_OUTPUT = (
    f"{STARTED_MARKER}\n"
    "[FAIL: vault should be drained] test_plainWithdrawDrainsVault() (gas: 1)\n"
    "Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 1ms\n"
)


class FakeClock:
    """Time only moves when the runner sleeps, so tests never wait."""

    def __init__(self):
        self.t = 0.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


def _job_status(kind: str, reason: str | None = None) -> dict:
    cond = {"type": kind, "status": "True"}
    if reason:
        cond["reason"] = reason
    return {"conditions": [cond]}


def _pod(
    exit_code: int | None,
    phase: str = "Succeeded",
    name: str = "poc-x-abc12",
    owner_uid: str = "uid-123",
) -> dict:
    if exit_code is None:
        status = {
            "phase": "Pending",
            "conditions": [
                {
                    "type": "PodScheduled",
                    "status": "False",
                    "reason": "Unschedulable",
                    "message": "0/3 nodes are available",
                }
            ],
        }
    else:
        status = {
            "phase": phase,
            "containerStatuses": [
                {"name": "run", "state": {"terminated": {"exitCode": exit_code}}}
            ],
        }
    metadata = {
        "name": name,
        "ownerReferences": [{"apiVersion": "batch/v1", "kind": "Job", "uid": owner_uid}],
    }
    return {"metadata": metadata, "status": status}


class FakeKube:
    """In-memory KubeApi. `polls` is the sequence of Job statuses successive
    `get_job` calls see after creation (the last one repeats); `pods` and
    `log` are what the finished Job exposes."""

    def __init__(
        self,
        *,
        polls: list[dict] | None = None,
        pods: list[dict] | None = None,
        log: str = PASS_OUTPUT,
        leftover: bool = False,
        leftover_gone_after: int = 2,
        errors: dict[str, KubeApiError] | None = None,
    ):
        self.polls = list(polls if polls is not None else [{}, _job_status("Complete")])
        self.pods = pods if pods is not None else [_pod(0)]
        self.log = log
        self.errors = errors or {}
        self.calls: list[tuple] = []
        self.secrets: dict[str, dict] = {}
        self.jobs: dict[str, dict] = {}
        self.created_job: dict | None = None
        self.created_secret: dict | None = None
        self.leftover_polls_left = leftover_gone_after if leftover else 0
        if leftover:
            self.jobs["leftover"] = {"metadata": {"name": "leftover"}}

    def _fail(self, call: str) -> None:
        if call in self.errors:
            raise self.errors[call]

    def create_secret(self, namespace, body):
        self.calls.append(("create_secret", namespace, body["metadata"]["name"]))
        self._fail("create_secret")
        self.created_secret = body
        self.secrets[body["metadata"]["name"]] = body
        return body

    def patch_secret(self, namespace, name, body):
        self.calls.append(("patch_secret", namespace, name, body))
        self._fail("patch_secret")
        self.secrets[name].setdefault("metadata", {}).update(body.get("metadata", {}))
        return self.secrets[name]

    def delete_secret(self, namespace, name):
        self.calls.append(("delete_secret", namespace, name))
        self._fail("delete_secret")
        self.secrets.pop(name, None)

    def create_job(self, namespace, body):
        self.calls.append(("create_job", namespace, body["metadata"]["name"]))
        self._fail("create_job")
        self.created_job = body
        self.jobs["current"] = {**body, "metadata": {**body["metadata"], "uid": "uid-123"}}
        return self.jobs["current"]

    def get_job(self, namespace, name):
        self.calls.append(("get_job", namespace, name))
        self._fail("get_job")
        if "leftover" in self.jobs:
            return self.jobs["leftover"]
        if self.leftover_polls_left > 0:
            self.leftover_polls_left -= 1
            return {"metadata": {"name": name, "deletionTimestamp": "2026-11-05T00:00:00Z"}}
        if "current" not in self.jobs:
            return None
        status = self.polls.pop(0) if len(self.polls) > 1 else self.polls[0]
        return {**self.jobs["current"], "status": status}

    def delete_job(self, namespace, name):
        self.calls.append(("delete_job", namespace, name))
        self._fail("delete_job")
        self.jobs.pop("leftover", None)
        self.jobs.pop("current", None)

    def list_pods(self, namespace, job_name):
        self.calls.append(("list_pods", namespace, job_name))
        self._fail("list_pods")
        return self.pods

    def read_pod_log(self, namespace, pod_name, container):
        self.calls.append(("read_pod_log", namespace, pod_name, container))
        self._fail("read_pod_log")
        return self.log

    def names(self) -> list[str]:
        return [c[0] for c in self.calls]


@pytest.fixture
def template_path(tmp_path: Path) -> Path:
    path = tmp_path / "job.yaml"
    path.write_text(TEMPLATE)
    return path


@pytest.fixture
def settings(template_path: Path) -> Settings:
    return Settings.from_env(
        {
            "SANDBOX_BACKEND": "kubernetes",
            "SANDBOX_NAMESPACE": NS,
            "SANDBOX_JOB_TEMPLATE": str(template_path),
            "SANDBOX_IMAGE": IMAGE,
        }
    )


def _run(settings: Settings, api: FakeKube, poc_id: str = "poc_1") -> SandboxResult:
    clock = FakeClock()
    api.clock = clock  # type: ignore[attr-defined]
    return run_poc_k8s(b"tar-bytes", poc_id, settings, api=api, sleep=clock.sleep, clock=clock.now)


# --- names and template filling -------------------------------------------


def test_job_name_is_a_deterministic_dns_label():
    assert job_name("poc_1") == "poc-poc-1"
    uuid_id = "poc_6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f"
    assert job_name(uuid_id) == "poc-poc-6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f"
    assert job_name(uuid_id) == job_name(uuid_id)
    assert job_name("PoC Weird/Chars!") == "poc-poc-weird-chars"
    assert job_name("___") == job_name("___") and job_name("___").startswith("poc-")


def test_job_name_shortens_long_ids_without_collisions():
    long_a, long_b = "x" * 80 + "a", "x" * 80 + "b"
    for poc_id in (long_a, long_b):
        name = job_name(poc_id)
        assert len(name) <= 63
        assert name == name.lower()
        assert name[0].isalnum() and name[-1].isalnum()
        assert all(c.isalnum() or c == "-" for c in name)
    assert job_name(long_a) != job_name(long_b)


def test_build_job_fills_exactly_the_contract_fields(settings, template_path):
    template = load_job_template(template_path)
    job = build_job(template, "poc-poc-1", NS, settings)
    assert job["metadata"]["name"] == "poc-poc-1"
    assert "generateName" not in job["metadata"]
    assert job["metadata"]["namespace"] == NS
    container = job["spec"]["template"]["spec"]["containers"][0]
    assert container["image"] == IMAGE
    assert container["command"][:2] == ["sh", "-c"]
    script = container["command"][2]
    assert script.startswith(f"echo {STARTED_MARKER}")
    assert "tar -x -f /in/project.tar -C /tmp/w" in script
    assert "timeout -s KILL 120 forge test" in script
    volumes = {v["name"]: v for v in job["spec"]["template"]["spec"]["volumes"]}
    assert volumes["project"]["secret"]["secretName"] == "poc-poc-1"
    # Everything else is Helm's and comes through untouched.
    pod = job["spec"]["template"]["spec"]
    assert pod["runtimeClassName"] == "kata-vm-isolation"
    assert pod["automountServiceAccountToken"] is False
    assert job["spec"]["activeDeadlineSeconds"] == 600
    assert job["spec"]["backoffLimit"] == 0
    assert container["name"] == "run"
    assert volumes["tmp"]["emptyDir"] == {"sizeLimit": "256Mi"}
    assert job["metadata"]["labels"]["app.kubernetes.io/component"] == "sandbox-run"
    # The template itself is not mutated.
    assert template["metadata"]["generateName"] == "sandbox-run-"


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("kind: Deployment\n", "not a Job manifest"),
        ("- just\n- a list\n", "not a Job manifest"),
        ("kind: Job\nspec: {template: {spec: {containers: []}}}\n", "no container"),
        (
            "kind: Job\nspec: {template: {spec: {containers: [{name: run}], volumes: []}}}\n",
            "no volume named 'project'",
        ),
        ("kind: [unclosed\n", "not valid YAML"),
    ],
)
def test_bad_template_is_rejected(tmp_path, text, message):
    path = tmp_path / "job.yaml"
    path.write_text(text)
    with pytest.raises(ValueError, match=message):
        load_job_template(path)


def test_missing_template_is_an_infra_error(tmp_path):
    settings = Settings.from_env(
        {"SANDBOX_NAMESPACE": NS, "SANDBOX_JOB_TEMPLATE": str(tmp_path / "nope.yaml")}
    )
    api = FakeKube()
    result = _run(settings, api)
    assert result.status is None
    assert "cannot be read" in result.infra_error
    assert api.calls == []


def test_missing_namespace_is_an_infra_error(template_path):
    settings = Settings.from_env({"SANDBOX_JOB_TEMPLATE": str(template_path)})
    api = FakeKube()
    result = _run(settings, api)
    assert result == SandboxResult(status=None, log="", infra_error="SANDBOX_NAMESPACE is not set")
    assert api.calls == []


# --- verdicts ---------------------------------------------------------------


def test_passing_poc(settings):
    api = FakeKube()
    result = _run(settings, api)
    assert result == SandboxResult(
        status="Passed", log=PASS_OUTPUT.split("\n", 1)[1], infra_error=None
    )
    # Secret first (base64 tar under project.tar), then the Job, then the
    # ownerReference so the GC drops the Secret with the Job.
    assert api.names()[:1] == ["get_job"]  # leftover check
    assert api.names()[1:4] == ["delete_secret", "create_secret", "create_job"]
    secret = api.created_secret
    assert (secret["metadata"]["name"], secret["metadata"]["namespace"]) == ("poc-poc-1", NS)
    assert secret["type"] == "Opaque"
    assert base64.b64decode(secret["data"]["project.tar"]) == b"tar-bytes"
    patch = next(c for c in api.calls if c[0] == "patch_secret")
    assert patch[3] == {
        "metadata": {
            "ownerReferences": [
                {"apiVersion": "batch/v1", "kind": "Job", "name": "poc-poc-1", "uid": "uid-123"}
            ]
        }
    }
    assert api.created_job["metadata"]["name"] == "poc-poc-1"
    assert ("read_pod_log", NS, "poc-x-abc12", "run") in api.calls
    # Cleanup: Job then Secret, always last.
    assert api.names()[-2:] == ["delete_job", "delete_secret"]
    assert api.jobs == {} and api.secrets == {}


def test_failing_poc(settings):
    api = FakeKube(polls=[_job_status("Failed", "BackoffLimitExceeded")], pods=[_pod(1)])
    api.log = FAIL_OUTPUT
    result = _run(settings, api)
    assert result.status == "Failed" and result.infra_error is None
    assert "vault should be drained" in result.log
    assert api.names()[-2:] == ["delete_job", "delete_secret"]


def test_exit_zero_without_passing_summary_is_fail(settings):
    api = FakeKube(log=f"{STARTED_MARKER}\ncompiled\n")
    assert _run(settings, api).status == "Failed"


def test_killed_in_container_is_a_failure_naming_both_limits(settings):
    api = FakeKube(
        polls=[_job_status("Failed", "BackoffLimitExceeded")],
        pods=[_pod(137, phase="Failed")],
        log=f"{STARTED_MARKER}\nCompiling...\n",
    )
    result = _run(settings, api)
    assert result.status == "Failed"
    assert result.log.startswith(
        "Killed after reaching the time limit (120s) or the memory limit (1 GB)"
    )
    assert "Compiling..." in result.log


def test_missing_started_marker_is_an_infra_error(settings):
    api = FakeKube(
        polls=[_job_status("Failed", "BackoffLimitExceeded")],
        pods=[_pod(127, phase="Failed")],
        log="sh: forge: not found\nexec /bin/sh: no such file or directory\n",
    )
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error == "exec /bin/sh: no such file or directory"
    assert "forge: not found" in result.log
    assert api.names()[-2:] == ["delete_job", "delete_secret"]


def test_empty_log_without_marker_names_the_exit(settings):
    api = FakeKube(pods=[_pod(1, phase="Failed")], log="")
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error == "sandbox container failed (exit 1)"


def test_huge_log_is_truncated_but_the_verdict_uses_all_of_it(settings):
    noise = ("x" * 99 + "\n") * 10_000
    api = FakeKube(log=STARTED_MARKER + "\n" + noise + PASS_OUTPUT)
    result = _run(settings, api)
    assert result.status == "Passed"
    assert len(result.log.encode()) <= LOG_LIMIT_BYTES + len("[truncated]\n")
    assert result.log.startswith("[truncated]\n")
    assert result.log.endswith(PASS_OUTPUT)


# --- waiting, deadlines, leftovers, errors ----------------------------------


def test_polls_every_two_seconds_until_the_job_finishes(settings):
    api = FakeKube(polls=[{}, {}, {}, _job_status("Complete")])
    clock = FakeClock()
    result = run_poc_k8s(b"t", "poc_1", settings, api=api, sleep=clock.sleep, clock=clock.now)
    assert result.status == "Passed"
    assert clock.sleeps == [POLL_INTERVAL_S] * 3


def test_outer_wait_is_the_templates_deadline_plus_grace(settings):
    api = FakeKube(polls=[{}])  # never finishes
    clock = FakeClock()
    result = run_poc_k8s(b"t", "poc_1", settings, api=api, sleep=clock.sleep, clock=clock.now)
    assert result.status is None
    assert result.infra_error == (
        f"Sandbox Job did not finish within {600 + WAIT_GRACE_S}s"
        f" (activeDeadlineSeconds 600 + {WAIT_GRACE_S}s)"
    )
    assert 600 + WAIT_GRACE_S <= clock.t < 600 + WAIT_GRACE_S + 2 * POLL_INTERVAL_S
    assert api.names()[-2:] == ["delete_job", "delete_secret"]
    assert "read_pod_log" not in api.names()


def test_outer_wait_follows_a_different_template_deadline(tmp_path):
    path = tmp_path / "job.yaml"
    path.write_text(TEMPLATE.replace("activeDeadlineSeconds: 600", "activeDeadlineSeconds: 30"))
    settings = Settings.from_env({"SANDBOX_NAMESPACE": NS, "SANDBOX_JOB_TEMPLATE": str(path)})
    api = FakeKube(polls=[{}])
    clock = FakeClock()
    result = run_poc_k8s(b"t", "poc_1", settings, api=api, sleep=clock.sleep, clock=clock.now)
    assert f"within {30 + WAIT_GRACE_S}s" in result.infra_error
    assert clock.t < 30 + WAIT_GRACE_S + 2 * POLL_INTERVAL_S


def test_deadline_exceeded_while_pending_is_a_retryable_infra_error(settings):
    # No node came in time (scale-up from zero, quota): the pod never ran,
    # there is no log, and the PoC is not to blame.
    api = FakeKube(polls=[{}, _job_status("Failed", "DeadlineExceeded")], pods=[_pod(None)])
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error.startswith("Sandbox Job hit its deadline (activeDeadlineSeconds 600)")
    assert "Unschedulable" in result.infra_error
    assert "read_pod_log" not in api.names()
    assert api.names()[-2:] == ["delete_job", "delete_secret"]


def test_deadline_exceeded_is_an_infra_error_even_with_a_killed_pod(settings):
    # forge is capped by `timeout -s KILL` inside the container, so the Job
    # deadline can only fire when start-up was slow: retry, don't fail the PoC.
    api = FakeKube(
        polls=[_job_status("Failed", "DeadlineExceeded")],
        pods=[_pod(137, phase="Failed")],
        log=f"{STARTED_MARKER}\nCompiling...\n",
    )
    result = _run(settings, api)
    assert result.status is None
    assert "hit its deadline" in result.infra_error


def test_job_failed_without_a_pod_is_an_infra_error(settings):
    api = FakeKube(polls=[_job_status("Failed", "BackoffLimitExceeded")], pods=[])
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error == (
        "Sandbox Job ended without running the PoC (BackoffLimitExceeded; pod no pod)"
    )


def test_leftover_job_is_deleted_and_waited_for_before_creating(settings):
    api = FakeKube(leftover=True, leftover_gone_after=2)
    clock = FakeClock()
    result = run_poc_k8s(b"t", "poc_1", settings, api=api, sleep=clock.sleep, clock=clock.now)
    assert result.status == "Passed"
    names = api.names()
    assert names[:2] == ["get_job", "delete_job"]
    # Polled until gone (two more get_job returning the terminating Job, then None).
    assert names.index("create_job") > names.index("delete_job")
    assert names[names.index("delete_job") + 1 : names.index("create_secret")] == [
        "get_job",
        "get_job",
        "get_job",
        "delete_secret",
    ]
    assert clock.sleeps[:2] == [POLL_INTERVAL_S, POLL_INTERVAL_S]


def test_leftover_job_that_never_goes_away_is_an_infra_error(settings):
    api = FakeKube(leftover=True, leftover_gone_after=10_000)
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error == (
        f"Kubernetes API error: leftover Job poc-poc-1 was not deleted within {DELETE_WAIT_S}s"
    )
    assert api.created_job is None
    assert api.names()[-2:] == ["delete_job", "delete_secret"]


def test_api_error_on_create_is_an_infra_error_and_still_cleans_up(settings):
    api = FakeKube(errors={"create_job": KubeApiError("403 Forbidden", status=403)})
    result = _run(settings, api)
    assert result == SandboxResult(
        status=None, log="", infra_error="Kubernetes API error: 403 Forbidden"
    )
    # The Secret was created before the Job failed: both deletes still run.
    assert api.names()[-2:] == ["delete_job", "delete_secret"]
    assert api.secrets == {}


def test_api_error_while_reading_the_log_is_an_infra_error(settings):
    api = FakeKube(errors={"read_pod_log": KubeApiError("400 Bad Request", status=400)})
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error == "Kubernetes API error: 400 Bad Request"
    assert api.names()[-2:] == ["delete_job", "delete_secret"]


def test_cleanup_errors_do_not_hide_the_verdict(settings):
    api = FakeKube(errors={"delete_job": KubeApiError("500 oops", status=500)})
    result = _run(settings, api)
    assert result.status == "Passed"
    assert api.names()[-2:] == ["delete_job", "delete_secret"]


def test_job_that_disappears_mid_run_is_an_infra_error(settings):
    api = FakeKube(polls=[{}])
    original = api.get_job
    seen = {"n": 0}

    def vanishing(namespace, name):
        seen["n"] += 1
        if seen["n"] > 2:
            api.jobs.pop("current", None)
        return original(namespace, name)

    api.get_job = vanishing  # type: ignore[method-assign]
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error == "Kubernetes API error: Job poc-poc-1 disappeared while running"


def test_runner_uses_the_sanitised_name_everywhere(settings):
    api = FakeKube()
    _run(settings, api, poc_id="PoC Weird/Chars!")
    names = {c[2] for c in api.calls if c[0] in {"create_secret", "create_job", "delete_job"}}
    assert names == {"poc-poc-weird-chars"}
    volumes = api.created_job["spec"]["template"]["spec"]["volumes"]
    assert next(v for v in volumes if v["name"] == "project")["secret"]["secretName"] == (
        "poc-poc-weird-chars"
    )


def test_stale_pod_of_a_deleted_leftover_job_is_ignored(settings):
    # The leftover Job's pod can linger in Terminating with the same job-name
    # label; only the pod owned by the Job we created decides the verdict.
    stale = _pod(0, name="poc-poc-1-old", owner_uid="uid-old")
    stale["metadata"]["deletionTimestamp"] = "2026-11-05T00:00:00Z"
    fresh = _pod(1, phase="Failed", name="poc-poc-1-new", owner_uid="uid-123")
    api = FakeKube(
        leftover=True,
        polls=[_job_status("Failed", "BackoffLimitExceeded")],
        pods=[stale, fresh],
        log=FAIL_OUTPUT,
    )
    result = _run(settings, api)
    assert result.status == "Failed"
    assert ("read_pod_log", NS, "poc-poc-1-new", "run") in api.calls
    assert not any(c[0] == "read_pod_log" and c[2] == "poc-poc-1-old" for c in api.calls)


def test_only_a_stale_pod_present_is_an_infra_error_not_its_verdict(settings):
    stale = _pod(0, name="poc-poc-1-old", owner_uid="uid-old")
    api = FakeKube(polls=[_job_status("Failed", "BackoffLimitExceeded")], pods=[stale])
    result = _run(settings, api)
    assert result.status is None
    assert result.infra_error.endswith("pod no pod)")
    assert "read_pod_log" not in api.names()


def test_oversized_project_fails_the_poc_without_touching_the_cluster(settings):
    api = FakeKube()
    clock = FakeClock()
    tar = b"x" * (MAX_TAR_BYTES + 1)
    result = run_poc_k8s(tar, "poc_1", settings, api=api, sleep=clock.sleep, clock=clock.now)
    assert result.status == "Failed" and result.infra_error is None
    assert result.log == (
        f"The contract and PoC ({MAX_TAR_BYTES + 1} bytes as a tar) exceed the sandbox's"
        " 900 KB project limit\n"
    )
    assert api.calls == []
    # Exactly at the limit still runs.
    api = FakeKube()
    assert run_poc_k8s(b"x" * MAX_TAR_BYTES, "poc_1", settings, api=api).status == "Passed"


# --- the adapter over the official client (fake underlying API objects) ----


class _Calls:
    def __init__(self, **responses):
        self.responses = responses
        self.calls: list[tuple[str, tuple, dict]] = []

    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            response = self.responses.get(name)
            if isinstance(response, BaseException):
                raise response
            return response

        return call


def _adapter(core=None, batch=None):
    from kubernetes import client

    return KubernetesApi(core or _Calls(), batch or _Calls(), client.ApiClient())


def test_adapter_deletes_jobs_with_background_propagation_and_ignores_404():
    from kubernetes.client.exceptions import ApiException

    batch = _Calls(delete_namespaced_job=ApiException(status=404, reason="Not Found"))
    api = _adapter(batch=batch)
    api.delete_job(NS, "poc-1")
    assert batch.calls == [
        ("delete_namespaced_job", ("poc-1", NS), {"propagation_policy": "Background"})
    ]


def test_adapter_turns_api_exceptions_into_kube_api_errors():
    from kubernetes.client.exceptions import ApiException

    batch = _Calls(create_namespaced_job=ApiException(status=403, reason="Forbidden"))
    with pytest.raises(KubeApiError) as info:
        _adapter(batch=batch).create_job(NS, {"metadata": {"name": "x"}})
    assert (info.value.status, info.value.reason) == (403, "403 Forbidden")


def test_adapter_turns_transport_errors_into_kube_api_errors():
    core = _Calls(create_namespaced_secret=ConnectionError("api server unreachable"))
    with pytest.raises(KubeApiError) as info:
        _adapter(core=core).create_secret(NS, {"metadata": {"name": "x"}})
    assert info.value.status is None
    assert "api server unreachable" in info.value.reason


def test_adapter_returns_plain_dicts_and_none_for_a_missing_job():
    from kubernetes import client
    from kubernetes.client.exceptions import ApiException

    job = client.V1Job(
        metadata=client.V1ObjectMeta(name="poc-1", uid="u1"),
        status=client.V1JobStatus(
            conditions=[client.V1JobCondition(type="Complete", status="True")]
        ),
    )
    batch = _Calls(read_namespaced_job=job)
    got = _adapter(batch=batch).get_job(NS, "poc-1")
    assert got["metadata"] == {"name": "poc-1", "uid": "u1"}
    assert got["status"]["conditions"][0] == {"type": "Complete", "status": "True"}
    missing = _Calls(read_namespaced_job=ApiException(status=404, reason="Not Found"))
    assert _adapter(batch=missing).get_job(NS, "poc-1") is None


def test_adapter_lists_pods_by_job_name_label():
    from kubernetes import client

    pods = client.V1PodList(items=[client.V1Pod(metadata=client.V1ObjectMeta(name="p1"))])
    core = _Calls(list_namespaced_pod=pods, read_namespaced_pod_log="hello\n")
    api = _adapter(core=core)
    assert api.list_pods(NS, "poc-1") == [{"metadata": {"name": "p1"}}]
    assert core.calls[0] == ("list_namespaced_pod", (NS,), {"label_selector": "job-name=poc-1"})
    assert api.read_pod_log(NS, "p1", "run") == "hello\n"
    assert core.calls[1] == ("read_namespaced_pod_log", ("p1", NS), {"container": "run"})


def test_template_fixture_matches_the_contract_shape():
    # Guard against the test template drifting from §4.2 while the chart's does not.
    doc = yaml.safe_load(TEMPLATE)
    pod = doc["spec"]["template"]["spec"]
    assert [v["name"] for v in pod["volumes"]] == ["tmp", "project"]
    assert pod["containers"][0]["image"] == "REPLACED_BY_RUNNER"
    assert pod["volumes"][1]["secret"]["secretName"] == "REPLACED_BY_RUNNER"
