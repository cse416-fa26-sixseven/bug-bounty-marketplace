from analysis.config import Settings, load_supported_solc


def test_defaults_from_empty_env():
    s = Settings.from_env({})
    assert (s.poll_interval_s, s.job_lease_s, s.job_max_attempts, s.worker_concurrency) == (
        1.0,
        600,
        3,
        2,
    )
    assert s.sandbox_timeout_s == 120
    assert s.sandbox_image == "bbm-sandbox:latest"
    assert s.database_url is None
    assert s.source_storage_dir is None
    assert s.llm_configured is False


def test_env_overrides_are_parsed():
    s = Settings.from_env(
        {
            "DATABASE_URL": "postgres://x",
            "SOURCE_STORAGE_DIR": "/data/storage",
            "POLL_INTERVAL_SECONDS": "0.5",
            "WORKER_CONCURRENCY": "4",
            "SANDBOX_TIMEOUT_SECONDS": "30",
        }
    )
    assert s.database_url == "postgres://x"
    assert str(s.source_storage_dir) == "/data/storage"
    assert s.poll_interval_s == 0.5
    assert s.worker_concurrency == 4
    assert s.sandbox_timeout_s == 30


def test_llm_configured_needs_all_three():
    env = {"LLM_ENDPOINT": "https://x", "LLM_API_KEY": "k", "LLM_MODEL": "grok"}
    assert Settings.from_env(env).llm_configured is True
    assert Settings.from_env({**env, "LLM_MODEL": ""}).llm_configured is False


def test_supported_solc_read_from_shared_file():
    assert load_supported_solc() == ("0.8.19", "0.8.20", "0.8.24", "0.8.26", "0.8.28", "0.7.6")
    assert Settings.from_env({}).supported_solc == load_supported_solc()


def test_challenge_window_default_and_override():
    assert Settings.from_env({}).challenge_window_s == 86400
    assert Settings.from_env({"CHALLENGE_WINDOW_SECONDS": "60"}).challenge_window_s == 60


def test_chain_enabled_flag():
    assert Settings.from_env({}).chain_enabled is False
    assert Settings.from_env({"CHAIN_ENABLED": "true"}).chain_enabled is True
    assert Settings.from_env({"CHAIN_ENABLED": "0"}).chain_enabled is False


def test_sandbox_backend_defaults_to_docker():
    s = Settings.from_env({})
    assert s.sandbox_backend == "docker"
    assert s.sandbox_namespace is None
    assert str(s.sandbox_job_template) == "/etc/bbm/sandbox/job.yaml"
    assert s.sandbox_config_error is None


def test_sandbox_kubernetes_settings_are_parsed():
    s = Settings.from_env(
        {
            "SANDBOX_BACKEND": "Kubernetes",
            "SANDBOX_NAMESPACE": "bbm-sandbox",
            "SANDBOX_JOB_TEMPLATE": "/tmp/job.yaml",
        }
    )
    assert s.sandbox_backend == "kubernetes"
    assert s.sandbox_namespace == "bbm-sandbox"
    assert str(s.sandbox_job_template) == "/tmp/job.yaml"
    assert s.sandbox_config_error is None


def test_kubernetes_backend_without_a_namespace_is_a_config_error():
    s = Settings.from_env({"SANDBOX_BACKEND": "kubernetes"})
    assert s.sandbox_config_error == "SANDBOX_BACKEND=kubernetes needs SANDBOX_NAMESPACE"
    blank = Settings.from_env({"SANDBOX_BACKEND": "kubernetes", "SANDBOX_NAMESPACE": "  "})
    assert blank.sandbox_config_error == "SANDBOX_BACKEND=kubernetes needs SANDBOX_NAMESPACE"


def test_unknown_sandbox_backend_is_a_config_error():
    s = Settings.from_env({"SANDBOX_BACKEND": "podman"})
    assert s.sandbox_config_error == "SANDBOX_BACKEND='podman' is not one of docker, kubernetes"
