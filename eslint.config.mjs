import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Harbour's SQLite boundary and agent payloads intentionally use dynamic
      // rows in legacy code. Stronger boundary typing should land module by
      // module instead of blocking unrelated UI/API work.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "deer-flow/**",
    "freellmapi/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local generated / auxiliary workspaces that are not part of this checkout.
    ".claude/**",
    ".playwright-cli/**",
    "coverage/**",
    "tsconfig.tsbuildinfo",
  ]),
  {
    rules: {
      // The codebase currently uses SQLite result casts in many places. Keep
      // lint focused on correctness issues until those DB types are tightened.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // These React Compiler-oriented rules are too noisy for the current app
      // patterns and are not enabled as runtime guarantees in this project.
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
