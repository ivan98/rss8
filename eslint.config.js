import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/", ".wrangler/", ".claude/", "worker-configuration.d.ts"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
  },
];
