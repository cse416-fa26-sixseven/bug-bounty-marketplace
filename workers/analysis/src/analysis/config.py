"""Worker settings, read from environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# solc-versions.txt (shipped inside this package) is the single list of solc
# versions the worker and the sandbox image support.
_SOLC_VERSIONS_FILE = Path(__file__).resolve().parent / "solc-versions.txt"
# Where the Helm chart mounts the sandbox Job template (ConfigMap
# bbm-sandbox-job-template, key job.yaml).
_SANDBOX_JOB_TEMPLATE = Path("/etc/bbm/sandbox/job.yaml")
SANDBOX_BACKENDS = ("docker", "kubernetes")


def load_supported_solc(path: Path | None = None) -> tuple[str, ...]:
    """Reads the supported solc versions, one per line, in file order."""
    target = path or Path(os.environ.get("SOLC_VERSIONS_FILE", _SOLC_VERSIONS_FILE))
    lines = target.read_text(encoding="utf-8").splitlines()
    return tuple(line.strip() for line in lines if line.strip() and not line.startswith("#"))


def _opt(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name, "").strip()
    return value or None


@dataclass(frozen=True)
class Settings:
    database_url: str | None
    source_storage_dir: Path | None
    #: https://<account>.blob.core.windows.net/<container>, read with the
    #: ambient Azure identity. Wins over source_storage_dir.
    source_storage_blob_container_url: str | None
    poll_interval_s: float
    job_lease_s: int
    job_max_attempts: int
    worker_concurrency: int
    llm_endpoint: str | None
    llm_api_key: str | None
    llm_model: str | None
    llm_timeout_s: float
    sandbox_timeout_s: int
    sandbox_image: str
    challenge_window_s: int
    sandbox_enabled: bool
    #: `docker` runs PoCs in throwaway containers on the Docker socket
    #: (Compose); `kubernetes` runs them as Jobs in `sandbox_namespace` (AKS).
    sandbox_backend: str
    sandbox_namespace: str | None
    sandbox_job_template: Path
    #: With a chain, the API applies sandbox verdicts on-chain and moves the
    #: finding; the worker only records the PoC's result.
    chain_enabled: bool
    supported_solc: tuple[str, ...]

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Settings:
        storage = _opt(env, "SOURCE_STORAGE_DIR")
        return cls(
            database_url=_opt(env, "DATABASE_URL"),
            source_storage_dir=Path(storage) if storage else None,
            source_storage_blob_container_url=_opt(env, "SOURCE_STORAGE_BLOB_CONTAINER_URL"),
            poll_interval_s=float(env.get("POLL_INTERVAL_SECONDS", "1")),
            job_lease_s=int(env.get("JOB_LEASE_SECONDS", "600")),
            job_max_attempts=int(env.get("JOB_MAX_ATTEMPTS", "3")),
            worker_concurrency=int(env.get("WORKER_CONCURRENCY", "2")),
            llm_endpoint=_opt(env, "LLM_ENDPOINT"),
            llm_api_key=_opt(env, "LLM_API_KEY"),
            llm_model=_opt(env, "LLM_MODEL"),
            llm_timeout_s=float(env.get("LLM_TIMEOUT_SECONDS", "90")),
            sandbox_timeout_s=int(env.get("SANDBOX_TIMEOUT_SECONDS", "120")),
            sandbox_image=_opt(env, "SANDBOX_IMAGE") or "bbm-sandbox:latest",
            challenge_window_s=int(env.get("CHALLENGE_WINDOW_SECONDS", "86400")),
            sandbox_enabled=env.get("SANDBOX_ENABLED", "").strip().lower()
            in {"1", "true", "yes", "on"},
            sandbox_backend=(_opt(env, "SANDBOX_BACKEND") or "docker").lower(),
            sandbox_namespace=_opt(env, "SANDBOX_NAMESPACE"),
            sandbox_job_template=Path(_opt(env, "SANDBOX_JOB_TEMPLATE") or _SANDBOX_JOB_TEMPLATE),
            chain_enabled=env.get("CHAIN_ENABLED", "").strip().lower()
            in {"1", "true", "yes", "on"},
            supported_solc=load_supported_solc(),
        )

    @staticmethod
    def dotenv_path() -> Path:
        """workers/analysis/.env in a checkout (absent in the container)."""
        return Path(__file__).resolve().parents[2] / ".env"

    @property
    def job_kinds(self) -> tuple[str, ...]:
        """Job kinds this worker claims. Sandbox jobs need a sandbox backend
        (the Docker socket, or Kubernetes Job access), so they are only taken
        when SANDBOX_ENABLED is set (otherwise they stay queued for a worker
        that has it)."""
        return ("analysis", "sandbox") if self.sandbox_enabled else ("analysis",)

    @property
    def sandbox_config_error(self) -> str | None:
        """Why sandbox jobs cannot run with these settings, or None. Logged at
        start-up; every sandbox job then fails as a (retryable) infra error
        rather than the worker refusing to start, so analysis jobs still run."""
        if self.sandbox_backend not in SANDBOX_BACKENDS:
            return (
                f"SANDBOX_BACKEND={self.sandbox_backend!r} is not one of "
                f"{', '.join(SANDBOX_BACKENDS)}"
            )
        if self.sandbox_backend == "kubernetes" and not self.sandbox_namespace:
            return "SANDBOX_BACKEND=kubernetes needs SANDBOX_NAMESPACE"
        return None

    @property
    def source_storage_configured(self) -> bool:
        """Whether some source store is set (see storage.open_store)."""
        return bool(self.source_storage_blob_container_url or self.source_storage_dir)

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_endpoint and self.llm_api_key and self.llm_model)
