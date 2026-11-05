# workers/sandbox

Docker image that auditors' Foundry PoCs run in (`bbm-sandbox:latest` locally,
`<acr>/bbm/sandbox:<tag>` on AKS). The analysis worker (`workers/analysis`)
starts one container per PoC, hands it the contract and PoC as a tar (on
stdin with Docker, from a Secret on Kubernetes), and runs `forge test` with:

- no network (`--network none`)
- 1 GB memory, 1 CPU, at most 256 processes
- a read-only root filesystem plus a 256 MB tmpfs at `/tmp`
- a non-root user, every Linux capability dropped, `no-new-privileges`
- a hard time limit (`SANDBOX_TIMEOUT_SECONDS`, default 120), enforced inside
  the container with `timeout -s KILL` (so it holds even if the worker dies)
  and again by the worker, which kills the container if it overruns

Because PoCs run offline, everything forge needs is baked in:

| What | Where | Version |
| --- | --- | --- |
| Foundry | base image | `ghcr.io/foundry-rs/foundry:v1.5.1` (forge 1.5.1) |
| solc | `/opt/solc/solc-<version>` | every version in `../analysis/src/analysis/solc-versions.txt`, sha256-checked |
| forge-std | `/opt/forge-std` | `f3dae6e`, the commit `contracts/lib/forge-std` pins |

## Build and smoke test

```sh
docker build -f workers/sandbox/Dockerfile -t bbm-sandbox:latest workers

tar -C workers/sandbox/smoke -c . | docker run --rm -i --network none \
  --read-only --tmpfs /tmp:rw,exec,size=256m --user 1000:1000 bbm-sandbox:latest \
  sh -c 'mkdir -p /tmp/w && tar -x -C /tmp/w && cd /tmp/w && forge test -vvv'
# expect: Suite result: ok. 1 passed; 0 failed
```

## Writing a PoC

A PoC is a Foundry test file. In the sandbox the submitted contract sits at
`src/<filename>` and the PoC at `test/PoC.t.sol`, so import the target as:

```solidity
import "forge-std/Test.sol";
import "../src/Vault.sol";
```

The PoC passes, and the finding becomes Verified, when at least one test
passes and none fail.

## Running it with the stack

Sandbox jobs are only claimed when the analysis service has
`SANDBOX_ENABLED=true` and the Docker socket, which the opt-in overlay adds:

```sh
docker build -f workers/sandbox/Dockerfile -t bbm-sandbox:latest workers
export DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build --wait db api analysis
```

The analysis image stays non-root (uid 10001); `group_add` gives it the
socket's group.

## Running it on AKS

On the clusters there is no Docker socket. The analysis Deployment runs with
`SANDBOX_BACKEND=kubernetes` and executes each PoC as a Kubernetes **Job** in
the release's `<namespace>-sandbox` namespace, on the Kata (`KataVmIsolation`)
`sandbox` node pool, so every PoC gets its own lightweight VM rather than a
shared kernel. Per PoC the worker:

1. builds the same tar as locally and stores it in a Secret `poc-<id>`
   (key `project.tar`), mounted read-only at `/in` in the pod;
2. creates Job `poc-<id>` from the template the Helm chart mounts at
   `/etc/bbm/sandbox/job.yaml`, filling in only the name, namespace, image,
   command (`tar -x -f /in/project.tar` then the usual `timeout -s KILL
   <SANDBOX_TIMEOUT_SECONDS> forge test`) and the Secret name. The template
   owns the isolation: `runtimeClassName: kata-vm-isolation`, the sandbox
   pool's nodeSelector/toleration, no ServiceAccount token, no service links,
   `runAsNonRoot` uid 10001, read-only root filesystem with a 256 MiB
   emptyDir at `/tmp`, all capabilities dropped, `RuntimeDefault` seccomp,
   1 CPU / 1 GiB / 1 GiB ephemeral limits, `backoffLimit: 0`,
   `activeDeadlineSeconds: 600` and `ttlSecondsAfterFinished`. The namespace
   enforces PSA `restricted`, a ResourceQuota and a deny-all NetworkPolicy
   (no DNS either), so "no network" holds on every environment;
3. polls the Job until it completes or fails (at most `activeDeadlineSeconds`
   + 60 s: the pool scales from zero, so the first PoC after an idle period
   waits a few minutes for a node), reads the pod log and the container's
   exit code, and applies the verdict rules above. A Job that hits its
   deadline before the PoC ran (no `bbm-sandbox-started` line, pod still
   Pending) is an infra error and the job is retried, never a PoC failure;
4. deletes the Job (and its pod) and the Secret, whatever happened; the
   Secret also carries an `ownerReference` to the Job as a backstop.

The analysis ServiceAccount's only Kubernetes rights are a Role in that
sandbox namespace (Jobs, Pods, pods/log, Secrets). See
`docs/superpowers/specs/2026-11-05-sandbox-aks-design.md` and
`docs/adr/0004-*.md`; the chart side is in `deploy/helm/README.md`.

