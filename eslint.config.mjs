import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import nextPlugin from "@next/eslint-plugin-next";

export default [
  {
    ignores: [".next/**", "node_modules/**", ".volguard/**", "playwright-report/**", "test-results/**", "eslint.config.mjs"],
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", project: "./tsconfig.json" },
    },
    plugins: { "@typescript-eslint": tsPlugin, "@next/next": nextPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      ...nextPlugin.configs.recommended.rules,
    },
  },
];
