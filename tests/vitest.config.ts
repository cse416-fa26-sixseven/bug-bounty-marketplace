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
// CI adds a JUnit report next to the default console output (plus GitHub
// annotations on Actions); locally `reporters` stays unset so vitest picks
// its own default. Each tier runs separately, so CI names the file per tier with
// `--outputFile.junit=reports/junit-<tier>.xml`.
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
    projects: [project("integration"), project("regression"), project("smoke")],
  },
});
