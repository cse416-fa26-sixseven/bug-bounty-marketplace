import { defineConfig } from "vitest/config";

// CI adds a JUnit report next to the default console output; local runs are
// unchanged. Coverage only runs with `--coverage` (CI), report-only.
const ci = !!process.env.CI;

export default defineConfig({
  test: {
    reporters: ci ? ["default", "junit"] : ["default"],
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "reports/coverage",
    },
  },
});
