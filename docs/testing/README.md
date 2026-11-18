# Test reports

CI (`.github/workflows/ci.yml`) writes JUnit XML and coverage for each test job and uploads
them as workflow artifacts (Actions run page → Artifacts). Coverage is report only: there
are no thresholds, and nothing here gates `CI OK`. Each coverage job also adds its total
to the run's step summary.

The `test-report` job reads those artifacts with `scripts/ci-test-report.py` and writes one
table per run: tests, passed, failed, skipped and line coverage for each suite. It goes to
the run summary, and on pull requests from this repository to a sticky PR comment that is
updated on every push (fork and Dependabot PRs get the summary only). A suite whose job
was skipped by its path filter shows as "not run".

| Artifact                                     | Job        | Contents                                                                                   |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `junit-web`, `coverage-web`                  | web        | `apps/web/reports/junit.xml`, `apps/web/reports/coverage/`                                 |
| `junit-shared`, `coverage-shared`            | shared     | `packages/shared/reports/junit.xml`, `packages/shared/reports/coverage/`                   |
| `junit-api`, `coverage-api`                  | api        | `apps/api/reports/junit.xml`, `apps/api/reports/coverage/`                                 |
| `junit-analysis`, `coverage-analysis`        | analysis   | `workers/analysis/reports/junit*.xml`, `workers/analysis/reports/coverage.xml` (Cobertura) |
| `junit-contracts`, `coverage-contracts`      | contracts  | `contracts/reports/junit.xml`, `contracts/lcov.info`, `contracts/coverage-summary.txt`     |
| `junit-system-tests`                         | containers | `tests/reports/junit-{integration,regression,smoke,e2e}.xml`                               |
| `playwright-report`                          | containers | Playwright HTML report                                                                     |
| `junit-e2e-chain`, `playwright-report-chain` | e2e-chain  | `tests/reports/junit-e2e.xml`, Playwright HTML report                                      |

Vitest coverage directories hold `coverage-summary.json`, `lcov.info` and an HTML report
(`lcov-report/`). Every `reports/` directory is gitignored.

## Producing them locally

The vitest configs add the JUnit reporter only when `CI` is set, so plain local runs print
the usual output. Coverage needs `--coverage`.

```sh
CI=1 pnpm --filter @bbm/api run test --coverage   # same for @bbm/web, @bbm/shared
CI=1 pnpm --filter @bbm/system-tests run test:smoke \
  --outputFile.junit=reports/junit-smoke.xml      # needs a running stack
pnpm test:e2e                                     # always writes tests/reports/junit-e2e.xml

cd workers/analysis
uv run pytest -q --junitxml=reports/junit.xml \
  --cov=analysis --cov-report=xml:reports/coverage.xml --cov-report=term

cd ../../contracts && forge coverage --report summary --report lcov
```

Milestone 5 results (counts, coverage, CI runs, bugs found): [m5-results.md](m5-results.md).
