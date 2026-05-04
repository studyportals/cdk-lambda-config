const tseslint = require("@typescript-eslint/eslint-plugin")
const tsParser = require("@typescript-eslint/parser")
const prettierRecommended = require("eslint-plugin-prettier/recommended")

const typedTsConfigs = tseslint.configs["flat/recommended-type-checked"].map(
  (config) => ({
    ...config,
    files: config.files ?? ["**/*.ts"],
  }),
)

module.exports = [
  {
    ignores: ["dist/**", "lib/**"],
  },
  ...typedTsConfigs,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        sourceType: "module",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
  prettierRecommended,
]
