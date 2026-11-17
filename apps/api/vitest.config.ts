import { defineConfig } from "vitest/config";

// CI adds a JUnit report next to the default console output (plus GitHub
// annotations on Actions); locally `reporters` stays unset so vitest picks
// its own default. Coverage only runs with `--coverage` (CI), report-only.
const ci = !!process.env.CI;
const reporters = [
  "default",
  "junit",
  ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
];

export default defineConfig({
  test: {
    ...(ci && { reporters }),
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "reports/coverage",
      // Every source file counts, not only the ones a test imports.
      include: ["src/**"],
      exclude: ["**/*.test.{ts,tsx}", "**/__tests__/**", "src/testing/**"],
    },
  },
});
