# Load tests (k6)

`api-baseline.js` is a baseline/soak test for the API. It goes straight to
the API origin, not through the web proxy.

- **`setup()`** checks `GET /health`. It then uploads one contract with
  `POST /api/contracts` (a multipart request built with `http.file`).
- **Each iteration** sends `GET /health` and `GET /api/contracts/:id` for
  that contract, then waits `THINK` seconds (default 1).
- **`baseline` scenario** (`ramping-vus`): ramps 0 → 20 VUs over 30s, holds
  for 1m, then ramps down over 30s.
- **`soak` scenario** (`constant-vus`): only runs with `SOAK=1`. It holds 10
  VUs for 10m, starting after the baseline ends. This covers the "stability
  under sustained load" goal.
- **Thresholds:** `http_req_failed` rate < 1% and `http_req_duration`
  p(95) < 500 ms. k6 exits non-zero if either one is breached.

The script reads no files (the `.sol` source is inlined), so you can pipe it
over stdin.

## Run

You don't need k6 installed. Use the pinned image `grafana/k6:2.3.0`:

```sh
# Against `pnpm stack:up` (Linux: host networking, so localhost works)
docker run --rm -i --network host -e BASE_URL=http://localhost:3001 \
  grafana/k6:2.3.0 run - < tests/load/api-baseline.js

# macOS / Windows Docker Desktop
docker run --rm -i -e BASE_URL=http://host.docker.internal:3001 \
  grafana/k6:2.3.0 run - < tests/load/api-baseline.js

# Against a deployed env (e.g. a CI-run namespace: https://run-<id>-<attempt>.test.<zone>)
docker run --rm -i -e BASE_URL=https://<host> \
  grafana/k6:2.3.0 run - < tests/load/api-baseline.js

# Baseline + 10-minute soak
docker run --rm -i -e BASE_URL=... -e SOAK=1 \
  grafana/k6:2.3.0 run - < tests/load/api-baseline.js

# 15-second sanity run
docker run --rm -i -e BASE_URL=... -e RAMP_UP=5s -e HOLD=5s -e RAMP_DOWN=5s \
  grafana/k6:2.3.0 run - < tests/load/api-baseline.js
```

| Env | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:3001` | API origin |
| `VUS` | `20` | Peak VUs for `baseline` |
| `RAMP_UP` / `HOLD` / `RAMP_DOWN` | `30s` / `1m` / `30s` | Shape of `baseline` |
| `THINK` | `1` | Seconds of sleep per iteration. `0` gives a max-throughput run. |
| `SOAK` | unset | `1` adds the 10m `soak` scenario |

`setup()` writes one contract per run, so don't point this at prod.
