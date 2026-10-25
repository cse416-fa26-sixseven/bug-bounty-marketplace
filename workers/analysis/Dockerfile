# syntax=docker/dockerfile:1.7

# ---- builder: resolve and install deps into /app/.venv with uv ----
FROM python:3.12-slim-bookworm AS builder

# Pinned uv binary (documented pattern: https://docs.astral.sh/uv/guides/integration/docker/).
# Keep in step with the uv version used to write uv.lock.
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# Dependencies first (cached layer), without the project itself.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project

# Then the project. Generated models are committed; they are NOT regenerated
# here because packages/shared/schema is outside this build context.
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# Slither compiles with solc. Pre-install every supported version into the
# venv (solc-select keeps them under $VIRTUAL_ENV/.solc-select), so analysis
# never downloads a compiler at run time.
ENV VIRTUAL_ENV=/app/.venv
RUN xargs -a src/analysis/solc-versions.txt -n1 /app/.venv/bin/solc-select install

# ---- runtime ----
FROM python:3.12-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="bbm-analysis" \
      org.opencontainers.image.description="Slither static analysis + advisory LLM explanations worker" \
      org.opencontainers.image.source="https://github.com/cse416-fa26-sixseven/bug-bounty-marketplace" \
      org.opencontainers.image.version="0.1.0"

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=builder --chown=10001:10001 /app/.venv /app/.venv
# Docker CLI only, for sandbox jobs (SANDBOX_ENABLED=true): PoCs run in
# throwaway bbm-sandbox containers on the Docker socket that
# docker-compose.sandbox.yml mounts. Unused otherwise.
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker

USER 10001
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).status == 200 else 1)"]

CMD ["uvicorn", "analysis.app:app", "--host", "0.0.0.0", "--port", "8000"]
