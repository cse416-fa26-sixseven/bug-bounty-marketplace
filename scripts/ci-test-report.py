#!/usr/bin/env python3
"""Build CI's test report (Markdown) from the JUnit and coverage artifacts.

Used by ci.yml's `test-report` job, which downloads every `junit-*` and
`coverage-*` artifact of the run into one directory (one sub-directory per
artifact) and posts this script's output as the run summary and as a sticky
PR comment. Report only: it always exits 0 for a readable directory, whatever
the tests did.

    scripts/ci-test-report.py <artifacts dir> [--results <json>] [--sha <sha>] [--run-url <url>]

--results is `toJSON(needs)` from the workflow ({"web": {"result": "success"},
...}); it tells a job skipped by its path filter ("not run") apart from one
that ran but left no report ("no report"). Without it both read "no report".
"""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# (label, CI job, JUnit globs, coverage source). Globs are relative to the
# artifacts directory. A coverage source is (kind, path) or None.
SUITES: list[tuple[str, str, list[str], tuple[str, str] | None]] = [
    ("web", "web", ["junit-web/*.xml"], ("json-summary", "coverage-web/coverage-summary.json")),
    (
        "shared",
        "shared",
        ["junit-shared/*.xml"],
        ("json-summary", "coverage-shared/coverage-summary.json"),
    ),
    ("api", "api", ["junit-api/*.xml"], ("json-summary", "coverage-api/coverage-summary.json")),
    (
        "contracts",
        "contracts",
        ["junit-contracts/*.xml"],
        ("lcov-src", "coverage-contracts/lcov.info"),
    ),
    (
        "analysis",
        "analysis",
        ["junit-analysis/*.xml"],
        ("cobertura", "coverage-analysis/coverage.xml"),
    ),
    ("integration", "containers", ["junit-system-tests/junit-integration.xml"], None),
    ("regression", "containers", ["junit-system-tests/junit-regression.xml"], None),
    ("smoke", "containers", ["junit-system-tests/junit-smoke.xml"], None),
    ("e2e (mocked)", "containers", ["junit-system-tests/junit-e2e.xml"], None),
    ("e2e (on-chain)", "e2e-chain", ["junit-e2e-chain/*.xml"], None),
]


def count_cases(files: list[Path]) -> dict[str, int] | None:
    """Totals over every <testcase> in the files, or None if none parse.

    Counts test cases rather than trusting the suite attributes, which differ
    between vitest, pytest, Playwright and forge (and nest in some of them).
    """
    totals = {"tests": 0, "failed": 0, "skipped": 0}
    parsed = False
    for file in files:
        try:
            root = ET.parse(file).getroot()
        except (ET.ParseError, OSError):
            continue
        parsed = True
        for case in root.iter("testcase"):
            totals["tests"] += 1
            if case.find("failure") is not None or case.find("error") is not None:
                totals["failed"] += 1
            elif case.find("skipped") is not None:
                totals["skipped"] += 1
    if not parsed:
        return None
    totals["passed"] = totals["tests"] - totals["failed"] - totals["skipped"]
    return totals


def line_coverage(kind: str, path: Path) -> float | None:
    """Line coverage in percent, or None when the report is missing or unreadable."""
    try:
        if kind == "json-summary":  # vitest/istanbul coverage-summary.json
            pct = json.loads(path.read_text())["total"]["lines"]["pct"]
            return float(pct) if isinstance(pct, (int, float)) else None
        if kind == "cobertura":  # pytest-cov coverage.xml
            return float(ET.parse(path).getroot().get("line-rate")) * 100
        if kind == "lcov-src":  # forge lcov, counting only contracts under src/
            found = hit = 0
            in_src = False
            for line in path.read_text().splitlines():
                if line.startswith("SF:"):
                    in_src = line[3:].startswith("src/")
                elif in_src and line.startswith("LF:"):
                    found += int(line[3:])
                elif in_src and line.startswith("LH:"):
                    hit += int(line[3:])
            return hit / found * 100 if found else None
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError):
        return None
    return None


def build(artifacts: Path, results: dict[str, str], sha: str, run_url: str) -> str:
    rows = []
    any_failed = False
    for label, job, globs, coverage in SUITES:
        files = sorted(f for g in globs for f in artifacts.glob(g))
        counts = count_cases(files) if files else None
        job_result = results.get(job, "")
        cov = line_coverage(coverage[0], artifacts / coverage[1]) if coverage else None
        cov_cell = f"{cov:.1f}%" if cov is not None else "–"
        if counts is None:
            if job_result == "skipped":
                status = "not run"
            elif job_result in ("failure", "cancelled"):
                status = f"❌ no report (job {job_result})"
                any_failed = True
            else:
                status = "no report"
            rows.append(f"| {label} | {status} | – | – | – | – | {cov_cell} |")
            continue
        failed = counts["failed"] > 0
        any_failed = any_failed or failed
        rows.append(
            f"| {label} | {'❌ failed' if failed else '✅ passed'} | {counts['tests']} | {counts['passed']} "
            f"| {counts['failed']} | {counts['skipped']} | {cov_cell} |"
        )

    ran = [r for r in rows if "✅" in r or "❌" in r]
    head = "### Test report"
    if not ran:
        verdict = "No test job ran for this commit (no relevant paths changed)."
    elif any_failed:
        verdict = "**Some tests failed.**"
    else:
        verdict = "All reported tests passed."
    meta = " · ".join(
        p for p in (f"`{sha[:7]}`" if sha else "", f"[run]({run_url})" if run_url else "") if p
    )
    lines = [
        head,
        "",
        f"{verdict} {meta}".rstrip(),
        "",
        "| Suite | Result | Tests | Passed | Failed | Skipped | Line coverage |",
        "|---|---|--:|--:|--:|--:|--:|",
        *rows,
        "",
        "<sub>Counts come from the JUnit reports and coverage from the coverage reports uploaded by this run. "
        "“not run” means the job was skipped because its paths did not change. "
        "Contracts coverage counts <code>src/</code> only. Report only: this comment never gates a merge.</sub>",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--results", default="", help="toJSON(needs) from the workflow")
    parser.add_argument("--sha", default="")
    parser.add_argument("--run-url", default="")
    args = parser.parse_args()
    if not args.artifacts.is_dir():
        print(f"{args.artifacts} is not a directory", file=sys.stderr)
        return 2
    results: dict[str, str] = {}
    if args.results:
        try:
            results = {
                job: str(value.get("result", "")) for job, value in json.loads(args.results).items()
            }
        except (ValueError, AttributeError):
            print("ignoring unreadable --results", file=sys.stderr)
    sys.stdout.write(build(args.artifacts, results, args.sha, args.run_url))
    return 0


if __name__ == "__main__":
    sys.exit(main())
