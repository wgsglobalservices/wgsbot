import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Dockerfile.bot", () => {
  it("starts the runtime without invoking pnpm/corepack at container boot", async () => {
    const dockerfile = await readFile("Dockerfile.bot", "utf8");

    expect(dockerfile).toContain("WORKDIR /app/apps/bot-runtime");
    expect(dockerfile).toContain('CMD ["node", "--import", "tsx", "src/server.ts"]');
    expect(dockerfile).not.toContain('CMD ["pnpm"');
  });
});
