import { defineConfig } from "vitest/config";

const project = (name: string) => ({
  test: {
    name,
    include: [`${name}/**/*.test.ts`],
    globalSetup: ["./lib/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

// Each tier is a separate project so CI can run them independently:
//   pnpm test:integration | test:regression | test:smoke
// CI adds a JUnit report next to the default console output; local runs are
// unchanged. Each tier runs separately, so CI names the file per tier with
// `--outputFile.junit=reports/junit-<tier>.xml`.
const ci = !!process.env.CI;

export default defineConfig({
  test: {
    reporters: ci ? ["default", "junit"] : ["default"],
    outputFile: { junit: "reports/junit.xml" },
    projects: [project("integration"), project("regression"), project("smoke")],
  },
});
