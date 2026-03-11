import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", ".tmp/**", "vitest.config.ts"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: true,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      // Catch discarded promises / return values
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Catch unreachable code and dead branches
      "no-unreachable": "error",
      "no-fallthrough": "error",
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        { allowConstantLoopConditions: true },
      ],
      // Catch missing switch cases for union types
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Catch unused expressions (side-effect-free statements)
      "@typescript-eslint/no-unused-expressions": "error",
      // Require return values from array methods (map, filter, etc.)
      "array-callback-return": "error",
      // Prevent assignments in conditions (if (x = 1) instead of if (x === 1))
      "no-cond-assign": "error",
      // Flag comparisons to self (x === x)
      "no-self-compare": "error",
      // Catch async functions that never await (source code only, not tests)
      "require-await": "off",
      "@typescript-eslint/require-await": "error",
      // Prevent awaiting non-Thenable values
      "@typescript-eslint/await-thenable": "error",
      // Prevent redundant type constituents (e.g., string | never)
      "@typescript-eslint/no-redundant-type-constituents": "error",
      // Prevent using value of void-returning expressions
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
    },
  },
  {
    // Test files: relax require-await since test mocks/stubs often implement
    // async interfaces without actually awaiting anything
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
];
