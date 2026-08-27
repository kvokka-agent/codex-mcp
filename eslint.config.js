import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // A test that reads the wall clock asserts on the runner's luck: a real
    // setTimeout(f, 40) runs on libuv's millisecond loop clock and fires with a
    // Date.now() delta of 39 about once in two thousand waits, which is how a
    // green pull request turned into a red master. tests/helpers/clock.ts holds
    // the fake clock the waits are measured on, and the readings of the real one
    // a fixture legitimately needs.
    files: ["tests/**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message:
            "A test measures on the fake clock. Drive it with useFakeClock() from tests/helpers/clock.js, or date a fixture with isoMsAgo/msAgo/msSince from there.",
        },
        {
          object: "performance",
          property: "now",
          message:
            "A test measures on the fake clock. Drive it with useFakeClock() from tests/helpers/clock.js.",
        },
        {
          object: "process",
          property: "hrtime",
          message:
            "A test measures on the fake clock. Drive it with useFakeClock() from tests/helpers/clock.js.",
        },
      ],
    },
  },
);

