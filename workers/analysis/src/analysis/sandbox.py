"""Runs an auditor's Foundry PoC in a locked-down, throwaway Docker container.

The contract and PoC go into the container as a tar on stdin (no bind mounts,
so the worker can itself run in a container with the Docker socket mounted).
The container has no network, capped CPU/memory/processes, a read-only root
filesystem and a hard time limit (R6, R12, R19).

This is the Docker backend (`SANDBOX_BACKEND=docker`, the Compose stack). The
Kubernetes backend in `sandbox_k8s.py` runs the same script as a Job and
shares the pieces exported here (`build_tarball`, `poc_script`, `verdict`,
`truncate_log`, `STARTED_MARKER`) so both reach exactly the same verdict.
"""

from __future__ import annotations

import io
import re
import subprocess
import tarfile
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from .config import Settings
from .paths import safe_filename

LOG_LIMIT_BYTES = 65_536
_TRUNCATED = "[truncated]\n"
_SUITE = re.compile(r"Suite result: (ok|FAILED)\. (\d+) passed; (\d+) failed")
KILLED_EXIT = 137  # 128 + SIGKILL: the in-container time limit or the memory cap
MEMORY_LIMIT = "1 GB"  # the cap both backends set (docker --memory / Job limits.memory)
# Printed by the container before anything else. Without it the container
# never started (Docker down, socket permission, missing image), whatever the
# exit code, so the failure is ours and the job is retried.
STARTED_MARKER = "bbm-sandbox-started"
# forge output kept inside the container, so a noisy PoC can't flood the
# worker's memory; the verdict lines are at the end.
_OUTPUT_CAP_BYTES = 262_144
# Time allowed for `docker rm` / `docker kill`.
_DOCKER_CALL_TIMEOUT_S = 30
# Extra time the outer subprocess allows for container start-up and teardown
# beyond the in-container limit, before the worker kills the container itself.
_STARTUP_GRACE_S = 30

Runner = Callable[..., subprocess.CompletedProcess]


@dataclass(frozen=True)
class SandboxResult:
    """`status` is None exactly when the sandbox itself could not run
    (`infra_error` set); that is our outage, not the auditor's failure."""

    status: Literal["Passed", "Failed"] | None
    log: str
    infra_error: str | None


def _foundry_toml(solc_version: str) -> str:
    return (
        "[profile.default]\n"
        'src = "src"\n'
        'test = "test"\n'
        "libs = []\n"
        "offline = true\n"
        "ffi = false\n"
        f'solc = "/opt/solc/solc-{solc_version}"\n'
        'remappings = ["forge-std/=/opt/forge-std/src/"]\n'
    )


def build_tarball(
    target_filename: str, target_source: bytes, poc_source: bytes, solc_version: str
) -> bytes:
    """The Foundry project the container runs: config, target and PoC."""
    files = {
        "foundry.toml": _foundry_toml(solc_version).encode(),
        f"src/{safe_filename(target_filename)}": target_source,
        "test/PoC.t.sol": poc_source,
    }
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def poc_script(timeout_s: int, tar_source: str | None = None) -> str:
    """The `sh -c` script both backends run: print the started marker, unpack
    the project (from stdin, or from the file `tar_source`), run forge under
    the in-container time limit, and print the capped output.

    The limit is enforced inside the container too, so a PoC can't keep
    running if the worker dies mid-run.
    """
    tar = f"tar -x -f {tar_source} -C /tmp/w" if tar_source else "tar -x -C /tmp/w"
    return (
        f"echo {STARTED_MARKER} && mkdir -p /tmp/w && {tar} && cd /tmp/w || exit 2; "
        f"timeout -s KILL {timeout_s} forge test -vvv > /tmp/forge.log 2>&1; c=$?; "
        f"tail -c {_OUTPUT_CAP_BYTES} /tmp/forge.log; exit $c"
    )


def container_name(poc_id: str) -> str:
    return f"bbm-sandbox-{poc_id}"


def docker_command(poc_id: str, settings: Settings) -> list[str]:
    return [
        "docker", "run", "--rm", "-i",
        "--name", container_name(poc_id),
        "--network", "none",
        "--memory", "1g",
        "--memory-swap", "1g",
        "--pull", "never",
        "--cpus", "1",
        "--pids-limit", "256",
        "--read-only",
        "--tmpfs", "/tmp:rw,exec,size=256m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", "1000:1000",
        settings.sandbox_image,
        "sh", "-c", poc_script(settings.sandbox_timeout_s),
    ]  # fmt: skip


def forge_passed(output: str) -> bool:
    """True iff forge reported at least one passing test and no failures."""
    suites = _SUITE.findall(output)
    if not suites:
        return False
    passed = sum(int(p) for _, p, _ in suites)
    failed = sum(int(f) for _, _, f in suites)
    return passed >= 1 and failed == 0 and all(r == "ok" for r, _, _ in suites)


def truncate_log(text: str) -> str:
    """Keeps the last LOG_LIMIT_BYTES bytes (the end of a forge run holds the
    verdict and the failing assertions)."""
    data = text.encode("utf-8")
    if len(data) <= LOG_LIMIT_BYTES:
        return text
    return _TRUNCATED + data[-LOG_LIMIT_BYTES:].decode("utf-8", errors="ignore")


def after_marker(output: str) -> str | None:
    """The output after the started-marker line, or None when the marker is
    missing (the sandbox itself never started: an infra error, not a verdict)."""
    if STARTED_MARKER not in output:
        return None
    return output.split(STARTED_MARKER + "\n", 1)[-1]


def verdict(exit_code: int, output: str, timeout_s: int) -> SandboxResult:
    """The verdict for a sandbox that did start, from forge's exit code and
    output (marker already stripped). Shared by both backends."""
    if exit_code == KILLED_EXIT:
        reason = (
            f"Killed after reaching the time limit ({timeout_s}s)"
            f" or the memory limit ({MEMORY_LIMIT})\n"
        )
        return SandboxResult(status="Failed", log=truncate_log(reason + output), infra_error=None)
    passed = exit_code == 0 and forge_passed(output)
    return SandboxResult(
        status="Passed" if passed else "Failed", log=truncate_log(output), infra_error=None
    )


def run_poc(
    tar: bytes, poc_id: str, settings: Settings, run: Runner = subprocess.run
) -> SandboxResult:
    timeout = settings.sandbox_timeout_s
    outer_timeout = timeout + _STARTUP_GRACE_S
    name = container_name(poc_id)
    try:
        # A container left over from a crashed worker would block the name.
        run(["docker", "rm", "-f", name], capture_output=True, timeout=_DOCKER_CALL_TIMEOUT_S)
        proc = run(
            docker_command(poc_id, settings),
            input=tar,
            capture_output=True,
            timeout=outer_timeout,
        )
    except subprocess.TimeoutExpired:
        # The in-container limit is the real one; getting here means start-up
        # or Docker itself was slow, so retry rather than blame the PoC.
        # Killing the client is not enough: stop the container itself.
        try:
            run(["docker", "kill", name], capture_output=True, timeout=_DOCKER_CALL_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            pass
        return SandboxResult(
            status=None,
            log="",
            infra_error=f"Sandbox did not finish within {outer_timeout}s; Docker may be slow",
        )
    except FileNotFoundError:
        return SandboxResult(status=None, log="", infra_error="Docker CLI not found")

    stdout = (proc.stdout or b"").decode("utf-8", errors="replace")
    stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
    output = after_marker(stdout)
    if output is None:
        lines = [line for line in stderr.strip().splitlines() if line.strip()]
        reason = lines[-1].strip() if lines else f"docker run failed (exit {proc.returncode})"
        return SandboxResult(status=None, log=truncate_log(stderr), infra_error=reason)
    return verdict(proc.returncode, output + stderr, timeout)
