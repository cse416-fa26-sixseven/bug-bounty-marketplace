# Sandbox image for re-running auditors' Foundry PoCs (bbm-sandbox:latest).
# Build from the workers/ directory so the shared solc list is in context:
#   docker build -f workers/sandbox/Dockerfile -t bbm-sandbox:latest workers
#
# PoCs run with no network, so everything forge needs is baked in:
# - Foundry, pinned by image tag
# - every solc in analysis/src/analysis/solc-versions.txt (the list the
#   analysis worker uses) at /opt/solc/solc-<version>,
#   checked against the sha256 published by soliditylang.org
# - forge-std at /opt/forge-std, the commit contracts/lib/forge-std pins

FROM alpine:3.20 AS fetch
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
RUN apk add --no-cache curl=8.14.1-r2 git=2.45.4-r0 jq=1.7.1-r0
ARG FORGE_STD_COMMIT=f3dae6e6ee381f25eb6a246f7da9b85c91a68219
COPY analysis/src/analysis/solc-versions.txt /tmp/solc-versions.txt
RUN base=https://binaries.soliditylang.org/linux-amd64; \
    fetch() { curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 "$@"; }; \
    fetch "$base/list.json" -o /tmp/list.json; \
    mkdir -p /opt/solc; \
    grep -v '^#' /tmp/solc-versions.txt | while read -r v; do \
      path=$(jq -r --arg v "$v" '.releases[$v]' /tmp/list.json); \
      sha=$(jq -r --arg p "$path" '.builds[] | select(.path == $p) | .sha256' /tmp/list.json | sed 's/^0x//'); \
      fetch "$base/$path" -o "/opt/solc/solc-$v"; \
      echo "$sha  /opt/solc/solc-$v" | sha256sum -c -; \
      chmod 0555 "/opt/solc/solc-$v"; \
    done
RUN git clone --quiet https://github.com/foundry-rs/forge-std /opt/forge-std \
 && git -C /opt/forge-std checkout --quiet "$FORGE_STD_COMMIT" \
 && rm -rf /opt/forge-std/.git

FROM ghcr.io/foundry-rs/foundry:v1.9.0
COPY --from=fetch /opt/solc /opt/solc
COPY --from=fetch /opt/forge-std /opt/forge-std
# The container's root filesystem is read-only at run time; point HOME at
# the writable tmpfs so forge can keep its caches there.
ENV HOME=/tmp \
    FOUNDRY_DISABLE_NIGHTLY_WARNING=1
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT []
