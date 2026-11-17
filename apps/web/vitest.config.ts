import path from "node:path";
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
  // Default (classic) JSX transform requires `React` in scope in every file
  // that uses JSX; Next's own SWC build already uses the automatic runtime,
  // so match it here rather than making every RTL test import React by hand.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // Node by default (fetch/FormData/File need to be Node's own
    // implementations for MSW's node interceptor to parse request bodies
    // correctly). Component tests that need the DOM can opt into jsdom
    // per-file with a `// @vitest-environment jsdom` docblock.
    environment: "node",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    ...(ci && { reporters }),
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "reports/coverage",
      // Every source file counts, not only the ones a test imports.
      include: ["src/**"],
      exclude: ["**/*.test.{ts,tsx}", "**/__tests__/**", "src/test/**", "src/mocks/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
