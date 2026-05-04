import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"]
    }
  },
  resolve: {
    alias: {
      "@minutesbot/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@minutesbot/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      "@minutesbot/recipient-policy": new URL("./packages/recipient-policy/src/index.ts", import.meta.url).pathname,
      "@minutesbot/invite-parser": new URL("./packages/invite-parser/src/index.ts", import.meta.url).pathname,
      "@minutesbot/attendee-client": new URL("./packages/attendee-client/src/index.ts", import.meta.url).pathname,
      "@minutesbot/summary-engine": new URL("./packages/summary-engine/src/index.ts", import.meta.url).pathname,
      "@minutesbot/email-renderer": new URL("./packages/email-renderer/src/index.ts", import.meta.url).pathname,
      "@minutesbot/email-sender": new URL("./packages/email-sender/src/index.ts", import.meta.url).pathname,
      "cloudflare:workers": new URL("./tests/cloudflare-workers.ts", import.meta.url).pathname
    }
  }
});
