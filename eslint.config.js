import kontentAiReactConfig from "@kontent-ai/eslint-config/react";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["dist", "eslint.config.js", "vite.config.ts", "src/vite-env.d.ts"],
    extends: [kontentAiReactConfig],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "react/jsx-max-props-per-line": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
    },
  },
]);
