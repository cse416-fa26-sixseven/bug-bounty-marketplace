#!/usr/bin/env bash
# Installs Playwright's headless Chromium for CI.
#
# The browser itself lives in ~/.cache/ms-playwright (the workflows cache it
# per Playwright version), so `playwright install` is a no-op on a cache hit.
#
# `--with-deps` is skipped on purpose: it pulls ~20 MB of fonts/xvfb/libnss3
# from the Ubuntu mirror, which sometimes crawls and turns a 20 s step into
# 10 min. GitHub's Ubuntu runners already ship Chrome's libraries, so we only
# fall back to apt when the browser can't actually launch, with short apt
# timeouts so a slow mirror retries instead of hanging.
set -euo pipefail

pw() { pnpm --filter @bbm/system-tests exec playwright "$@"; }

launches() {
  timeout 60 pnpm --filter @bbm/system-tests exec node -e \
    "import('@playwright/test').then(({ chromium }) => chromium.launch()).then((b) => b.close())"
}

pw install --only-shell chromium

if launches; then
  echo "Chromium launches with the runner's system libraries; skipping apt."
  exit 0
fi

echo "::notice::Chromium could not launch; installing its system dependencies via apt."
sudo tee /etc/apt/apt.conf.d/99playwright-timeouts >/dev/null <<'EOF'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "3";
EOF
pw install-deps chromium
launches
