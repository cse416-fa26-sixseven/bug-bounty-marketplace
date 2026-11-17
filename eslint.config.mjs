// Root ESLint flat config shared across the workspace.
// Individual packages (apps/*, packages/*) may extend or override this
// as their real code lands in later branches.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/out/**",
      "**/cache/**",
      "contracts/**",
      "workers/**",
      "tests/e2e/playwright-report/**",
      "tests/e2e/test-results/**",
      // Local/CI test reports (coverage HTML ships its own JS).
      "**/reports/**",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
