"""Runs an auditor's Foundry PoC as a Kubernetes Job (`SANDBOX_BACKEND=kubernetes`).

On AKS the worker holds no Docker socket. Instead it loads the Job template
Helm renders into a ConfigMap (`SANDBOX_JOB_TEMPLATE`), fills in only the name,
namespace, image, command and the Secret holding the project tar, and lets the
cluster run it on the Kata-isolated sandbox pool (see
docs/superpowers/specs/2026-11-05-sandbox-aks-design.md §3–4). Everything
security-relevant (runtimeClass, no network, no token, read-only root, limits,
deadline) is owned by the template, not by this module.

The verdict is the Docker backend's, by construction: the pod log must start
with the started marker (else the sandbox never ran: infra error, retried),
exit 137 is `Failed` naming both limits, exit 0 with a passing suite is
`Passed`, anything else `Failed`, logs truncated with `truncate_log`.

The API server is reached through the small `KubeApi` protocol so unit tests
use an in-memory fake and never open a socket; `KubernetesApi` is the
production adapter over the official client (in-cluster config).
"""

from __future__ import annotations

import base64
import copy
import hashlib
import logging
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

import yaml

from .config import Settings
from .sandbox import SandboxResult, after_marker, poc_script, truncate_log, verdict

log = logging.getLogger(__name__)

JsonDict = dict[str, Any]

#: Where the template mounts the project Secret (`project` volume), and the
#: key the tar is stored under in it.
PROJECT_MOUNT = "/in"
PROJECT_KEY = "project.tar"
#: Name of the volume in the template whose `secret.secretName` is filled in.
PROJECT_VOLUME = "project"
#: `activeDeadlineSeconds` assumed when the template does not set one (the
#: chart's default); the worker waits this plus a grace period.
DEFAULT_ACTIVE_DEADLINE_S = 600
#: Extra wait beyond the Job's own deadline before the worker gives up (the
#: controller needs a moment to mark the Job failed and tear the pod down).
WAIT_GRACE_S = 60
#: Between Job status polls.
POLL_INTERVAL_S = 2.0
#: How long to wait for a leftover Job of the same name to disappear.
DELETE_WAIT_S = 60
#: Largest project tar stored in the Secret (the API object limit is 1 MiB
#: and base64 adds a third; the API caps sources at 100 KB each, so a real
#: project is ~210 KB). Bigger is the PoC's problem, not an outage.
MAX_TAR_BYTES = 900_000
_NAME_MAX = 63
_NAME_PREFIX = "poc-"
_UNSAFE = re.compile(r"[^a-z0-9-]+")


class KubeApiError(Exception):
    """An API call failed (HTTP status in `status`, None when the request never
    got an answer: DNS, TLS, timeouts). Always an infra error for the PoC."""

    def __init__(self, reason: str, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class KubeApi(Protocol):
    """The handful of calls the runner needs, on plain JSON-shaped dicts.

    Implementations raise `KubeApiError` on failure; `get_job` returns None
    and the deletes return quietly when the object does not exist.
    """

    def create_secret(self, namespace: str, body: JsonDict) -> JsonDict: ...

    def patch_secret(self, namespace: str, name: str, body: JsonDict) -> JsonDict: ...

    def delete_secret(self, namespace: str, name: str) -> None: ...

    def create_job(self, namespace: str, body: JsonDict) -> JsonDict: ...

    def get_job(self, namespace: str, name: str) -> JsonDict | None: ...

    def delete_job(self, namespace: str, name: str) -> None:
        """Deletes the Job and (propagation Background) its pods."""
        ...

    def list_pods(self, namespace: str, job_name: str) -> list[JsonDict]: ...

    def read_pod_log(self, namespace: str, pod_name: str, container: str) -> str: ...


class KubernetesApi:
    """`KubeApi` over the official `kubernetes` client. Built with
    `in_cluster()` in the analysis pod; the constructor takes the API objects
    so tests can hand in fakes."""

    def __init__(self, core: Any, batch: Any, api_client: Any):
        self._core = core
        self._batch = batch
        self._api_client = api_client

    @classmethod
    def in_cluster(cls) -> KubernetesApi:
        from kubernetes import client, config

        config.load_incluster_config()
        api_client = client.ApiClient()
        return cls(client.CoreV1Api(api_client), client.BatchV1Api(api_client), api_client)

    def _call(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        from kubernetes.client.exceptions import ApiException

        try:
            return fn(*args, **kwargs)
        except ApiException as err:
            raise KubeApiError(f"{err.status} {err.reason}", status=err.status) from err
        except Exception as err:  # urllib3/ssl/socket: the API server is unreachable
            raise KubeApiError(f"{type(err).__name__}: {err}") from err

    def _dict(self, obj: Any) -> JsonDict:
        return self._api_client.sanitize_for_serialization(obj)

    def _ignore_404(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        try:
            return self._call(fn, *args, **kwargs)
        except KubeApiError as err:
            if err.status == 404:
                return None
            raise

    def create_secret(self, namespace: str, body: JsonDict) -> JsonDict:
        return self._dict(self._call(self._core.create_namespaced_secret, namespace, body))

    def patch_secret(self, namespace: str, name: str, body: JsonDict) -> JsonDict:
        return self._dict(self._call(self._core.patch_namespaced_secret, name, namespace, body))

    def delete_secret(self, namespace: str, name: str) -> None:
        self._ignore_404(self._core.delete_namespaced_secret, name, namespace)

    def create_job(self, namespace: str, body: JsonDict) -> JsonDict:
        return self._dict(self._call(self._batch.create_namespaced_job, namespace, body))

    def get_job(self, namespace: str, name: str) -> JsonDict | None:
        job = self._ignore_404(self._batch.read_namespaced_job, name, namespace)
        return None if job is None else self._dict(job)

    def delete_job(self, namespace: str, name: str) -> None:
        self._ignore_404(
            self._batch.delete_namespaced_job, name, namespace, propagation_policy="Background"
        )

    def list_pods(self, namespace: str, job_name: str) -> list[JsonDict]:
        pods = self._call(
            self._core.list_namespaced_pod, namespace, label_selector=f"job-name={job_name}"
        )
        return list(self._dict(pods).get("items") or [])

    def read_pod_log(self, namespace: str, pod_name: str, container: str) -> str:
        text = self._call(
            self._core.read_namespaced_pod_log, pod_name, namespace, container=container
        )
        return text if isinstance(text, str) else str(text)


def job_name(poc_id: str) -> str:
    """`poc-<sanitised id>`: a DNS label (lower-case `[a-z0-9-]`, ≤ 63 chars,
    alphanumeric at both ends), deterministic so a retry can delete the
    leftover Job of the same name. Ids that would not fit are shortened with
    a hash suffix so distinct ids never collide."""
    cleaned = _UNSAFE.sub("-", poc_id.lower()).strip("-")
    name = _NAME_PREFIX + cleaned
    if cleaned and len(name) <= _NAME_MAX:
        return name
    digest = hashlib.sha256(poc_id.encode()).hexdigest()[:10]
    head = cleaned[: _NAME_MAX - len(_NAME_PREFIX) - len(digest) - 1].rstrip("-")
    return f"{_NAME_PREFIX}{head}-{digest}" if head else _NAME_PREFIX + digest


def load_job_template(path: Path) -> JsonDict:
    """The Job template from `SANDBOX_JOB_TEMPLATE`. Raises `ValueError` when it
    is missing, not YAML or not a Job with one container and a `project`
    volume (the §4.2 contract the chart promises)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as err:
        raise ValueError(f"Sandbox Job template {path} cannot be read: {err}") from err
    try:
        template = yaml.safe_load(text)
    except yaml.YAMLError as err:
        raise ValueError(f"Sandbox Job template {path} is not valid YAML: {err}") from err
    if not isinstance(template, dict) or template.get("kind") != "Job":
        raise ValueError(f"Sandbox Job template {path} is not a Job manifest")
    pod = _pod_spec(template)
    if not pod.get("containers"):
        raise ValueError(f"Sandbox Job template {path} has no container")
    if _project_volume(pod) is None:
        raise ValueError(f"Sandbox Job template {path} has no volume named {PROJECT_VOLUME!r}")
    return template


def _pod_spec(template: JsonDict) -> JsonDict:
    return template.setdefault("spec", {}).setdefault("template", {}).setdefault("spec", {})


def _project_volume(pod: JsonDict) -> JsonDict | None:
    for volume in pod.get("volumes") or []:
        if isinstance(volume, dict) and volume.get("name") == PROJECT_VOLUME:
            return volume
    return None


def build_job(template: JsonDict, name: str, namespace: str, settings: Settings) -> JsonDict:
    """A copy of the template with exactly the §4.2 fields filled in."""
    job = copy.deepcopy(template)
    metadata = job.setdefault("metadata", {})
    metadata.pop("generateName", None)
    metadata["name"] = name
    metadata["namespace"] = namespace
    pod = _pod_spec(job)
    container = pod["containers"][0]
    container["image"] = settings.sandbox_image
    container["command"] = [
        "sh",
        "-c",
        poc_script(settings.sandbox_timeout_s, tar_source=f"{PROJECT_MOUNT}/{PROJECT_KEY}"),
    ]
    volume = _project_volume(pod)
    assert volume is not None  # load_job_template checked
    volume.setdefault("secret", {})["secretName"] = name
    return job


def build_secret(name: str, namespace: str, tar: bytes) -> JsonDict:
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": name, "namespace": namespace},
        "type": "Opaque",
        "data": {PROJECT_KEY: base64.b64encode(tar).decode("ascii")},
    }


def owner_reference(job: JsonDict) -> JsonDict:
    """The Secret's ownerReference to its Job, so the garbage collector drops
    the Secret with the Job even if the worker dies before its `finally`."""
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "name": job["metadata"]["name"],
        "uid": job["metadata"]["uid"],
    }


def active_deadline(template: JsonDict) -> int:
    value = (template.get("spec") or {}).get("activeDeadlineSeconds")
    return int(value) if value else DEFAULT_ACTIVE_DEADLINE_S


def _condition(job: JsonDict, kind: str) -> JsonDict | None:
    for condition in (job.get("status") or {}).get("conditions") or []:
        if condition.get("type") == kind and str(condition.get("status")) == "True":
            return condition
    return None


def _terminated(pod: JsonDict, container: str) -> JsonDict | None:
    """The container's terminated state, or None while it has not finished."""
    for status in (pod.get("status") or {}).get("containerStatuses") or []:
        if status.get("name") == container:
            return (status.get("state") or {}).get("terminated")
    return None


def _pod_summary(pod: JsonDict) -> str:
    status = pod.get("status") or {}
    phase = status.get("phase") or "Unknown"
    for condition in status.get("conditions") or []:
        if condition.get("type") == "PodScheduled" and str(condition.get("status")) != "True":
            return _why(phase, condition)
    for cs in status.get("containerStatuses") or []:
        waiting = (cs.get("state") or {}).get("waiting")
        if waiting:
            return _why(phase, waiting)
    return phase


def _why(phase: str, state: JsonDict) -> str:
    return f"{phase}: {state.get('reason') or ''} {state.get('message') or ''}".strip()


def run_poc_k8s(
    tar: bytes,
    poc_id: str,
    settings: Settings,
    api: KubeApi | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> SandboxResult:
    """The `PocRunner` for `SANDBOX_BACKEND=kubernetes`."""
    namespace = settings.sandbox_namespace
    if not namespace:
        return _infra("SANDBOX_NAMESPACE is not set")
    try:
        template = load_job_template(settings.sandbox_job_template)
    except ValueError as err:
        return _infra(str(err))
    if len(tar) > MAX_TAR_BYTES:
        return SandboxResult(
            status="Failed",
            log=(
                f"The contract and PoC ({len(tar)} bytes as a tar) exceed the sandbox's"
                f" {MAX_TAR_BYTES // 1000} KB project limit\n"
            ),
            infra_error=None,
        )
    name = job_name(poc_id)
    timeout = settings.sandbox_timeout_s
    deadline_s = active_deadline(template)
    outer_wait = deadline_s + WAIT_GRACE_S
    container = template["spec"]["template"]["spec"]["containers"][0].get("name") or "run"
    if api is None:
        try:
            api = KubernetesApi.in_cluster()
        except Exception as err:  # no token mounted, bad config
            return _infra(f"Kubernetes client unavailable: {type(err).__name__}: {err}")

    try:
        # A Job/Secret left over from a crashed worker would block the name.
        _remove_leftovers(api, namespace, name, sleep, clock)
        api.create_secret(namespace, build_secret(name, namespace, tar))
        job = api.create_job(namespace, build_job(template, name, namespace, settings))
        uid = (job.get("metadata") or {}).get("uid")
        if uid:
            api.patch_secret(
                namespace, name, {"metadata": {"ownerReferences": [owner_reference(job)]}}
            )
        finished = _wait_for_job(api, namespace, name, outer_wait, sleep, clock)
        if finished is None:
            return _infra(
                f"Sandbox Job did not finish within {outer_wait}s"
                f" (activeDeadlineSeconds {deadline_s} + {WAIT_GRACE_S}s)"
            )
        uid = uid or (finished.get("metadata") or {}).get("uid")
        return _collect(api, namespace, name, uid, container, finished, deadline_s, timeout)
    except KubeApiError as err:
        return _infra(f"Kubernetes API error: {err.reason}")
    finally:
        _cleanup(api, namespace, name)


def _infra(reason: str) -> SandboxResult:
    return SandboxResult(status=None, log="", infra_error=reason)


def _remove_leftovers(
    api: KubeApi,
    namespace: str,
    name: str,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
) -> None:
    if api.get_job(namespace, name) is not None:
        log.info("sandbox job %s already exists; deleting the leftover first", name)
        api.delete_job(namespace, name)
        give_up = clock() + DELETE_WAIT_S
        while api.get_job(namespace, name) is not None:
            if clock() >= give_up:
                raise KubeApiError(f"leftover Job {name} was not deleted within {DELETE_WAIT_S}s")
            sleep(POLL_INTERVAL_S)
    # The Secret is normally garbage-collected with the Job; a 404 is fine.
    api.delete_secret(namespace, name)


def _wait_for_job(
    api: KubeApi,
    namespace: str,
    name: str,
    outer_wait: float,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
) -> JsonDict | None:
    """Polls until the Job has a Complete or Failed condition; None when the
    outer wait runs out first."""
    give_up = clock() + outer_wait
    while True:
        job = api.get_job(namespace, name)
        if job is None:
            raise KubeApiError(f"Job {name} disappeared while running")
        if _condition(job, "Complete") or _condition(job, "Failed"):
            return job
        if clock() >= give_up:
            return None
        sleep(POLL_INTERVAL_S)


def _owned_by(pod: JsonDict, uid: str | None) -> bool:
    """Only the pods of this Job: a leftover Job of the same name deleted
    just before (Background propagation) can leave its pod Terminating with
    the same `job-name` label, and its log must never become the verdict."""
    if uid is None:
        return True
    refs = (pod.get("metadata") or {}).get("ownerReferences") or []
    return any(ref.get("uid") == uid for ref in refs)


def _collect(
    api: KubeApi,
    namespace: str,
    name: str,
    uid: str | None,
    container: str,
    job: JsonDict,
    deadline_s: int,
    timeout: int,
) -> SandboxResult:
    failed = _condition(job, "Failed")
    pods = [p for p in api.list_pods(namespace, name) if _owned_by(p, uid)]
    detail = "; ".join(_pod_summary(p) for p in pods) or "no pod"
    if failed and failed.get("reason") == "DeadlineExceeded":
        # forge is capped by `timeout -s KILL` well inside the deadline, so
        # reaching it means the pod was slow to start (node scale-up, image
        # pull, quota): our outage, not the auditor's. Same as the Docker
        # backend's outer timeout.
        return _infra(
            f"Sandbox Job hit its deadline (activeDeadlineSeconds {deadline_s})"
            f" before the PoC finished; pod {detail}"
        )
    pod = next((p for p in pods if _terminated(p, container)), None)
    if pod is None:
        # Failed without a finished container: evicted, image missing, quota.
        why = failed.get("reason") if failed else "no condition"
        return _infra(f"Sandbox Job ended without running the PoC ({why}; pod {detail})")
    terminated = _terminated(pod, container)
    assert terminated is not None
    exit_code = int(terminated.get("exitCode") or 0)
    text = api.read_pod_log(namespace, pod["metadata"]["name"], container)
    output = after_marker(text)
    if output is None:
        reason = terminated.get("reason") or f"exit {exit_code}"
        lines = [line for line in text.strip().splitlines() if line.strip()]
        detail = lines[-1].strip() if lines else f"sandbox container failed ({reason})"
        return SandboxResult(status=None, log=truncate_log(text), infra_error=detail)
    return verdict(exit_code, output, timeout)


def _cleanup(api: KubeApi, namespace: str, name: str) -> None:
    for what, delete in (("job", api.delete_job), ("secret", api.delete_secret)):
        try:
            delete(namespace, name)
        except KubeApiError as err:
            # The Job's ttlSecondsAfterFinished and the Secret's ownerReference
            # are the backstop; nothing more to do from here.
            log.warning("could not delete sandbox %s %s: %s", what, name, err.reason)
