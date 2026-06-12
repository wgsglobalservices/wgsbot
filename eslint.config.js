import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".wrangler/**", "**/*.d.ts"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The Playwright driver in apps/bot-runtime works against untyped page
      // objects on purpose; `any` is a deliberate choice there.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Worker globals (caches, crypto, etc.) are provided by the runtime.
      "no-undef": "off"
    }
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      // Test fakes capture the instance with `const db = this` so nested
      // statement objects can record calls; that idiom is fine.
      "@typescript-eslint/no-this-alias": "off"
    }
  },
  prettier
);
