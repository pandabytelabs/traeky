const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const reactRefresh = require("eslint-plugin-react-refresh");

/** @type {import("eslint").Linter.FlatConfig[]} */
module.exports = [
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...(tsPlugin.configs && tsPlugin.configs.recommended
        ? tsPlugin.configs.recommended.rules
        : {}),
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
];
