// Repo lint standard. Two worlds, two profiles:
//  - shell/ (+ registry scripts): plain CommonJS Node - the compact,
//    callback-y Electron host. Empty catches and unused handler args are
//    idiomatic there, so they're allowed; everything else is eslint:recommended.
//  - launcher/: TS + React 10-foot UI - typescript-eslint recommended +
//    react-hooks rules.
// Formatting is Prettier's job (see .prettierrc); eslint-config-prettier
// switches every stylistic rule off so the two never fight.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "shell/launcher-dist/",
      "shell/apps-data/",
      "shell/electron-web-client/",
      "launcher/dist/",
      "dist/",
    ],
  },

  // ---- shell + repo node scripts (CommonJS) ----
  {
    files: ["shell/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off", // \0-stripping /proc/device-tree strings is legit
    },
  },

  // ---- renderer-context shell code: the preload bridge + per-app bridge
  // adapters run inside pages, so they see `window`/DOM on top of Node ----
  {
    files: ["shell/preload.js", "shell/bridges/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // ---- launcher (TS + React) ----
  {
    files: ["launcher/**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // the two classic hook rules; the v7 compiler-adjacent extras are too
      // noisy for handwritten refs/timers (Date.now() in initializers, …)
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },

  prettier,
);
