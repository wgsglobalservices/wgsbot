import { parseSettings } from "@minutesbot/shared";
import { describe, expect, it } from "vitest";
import { buildSeedSql, seedDev, seedSettings } from "./seed-dev";

describe("seedSettings", () => {
  it("is compatible with the shared settings schema", () => {
    const parsed = parseSettings(seedSettings);
    expect(parsed.companyName).toBe(seedSettings.companyName);
    // Local development must never send real email.
    expect(parsed.email.provider).toBe("mock");
    // Product invariants enforced by the schema.
    expect(parsed.policy.sendToAllowedDomainsOnly).toBe(true);
    expect(parsed.policy.sendToExternalAttendees).toBe(false);
  });
});

describe("buildSeedSql", () => {
  it("writes the settings row under the 'app' key and mirrors allowed_domains", () => {
    const sql = buildSeedSql(() => "2026-01-01T00:00:00.000Z");
    expect(sql).toContain("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app',");
    expect(sql).toContain("DELETE FROM allowed_domains;");
    expect(sql).toContain("INSERT INTO allowed_domains");
    expect(sql).toContain("'example.com'");
    expect(sql).toContain("'2026-01-01T00:00:00.000Z'");
  });

  it("produces JSON that round-trips through the SQL escaping", () => {
    const sql = buildSeedSql(() => "2026-01-01T00:00:00.000Z");
    const match = sql.match(/VALUES \('app', '((?:[^']|'')*)'/);
    expect(match).not.toBeNull();
    const unescaped = (match as RegExpMatchArray)[1].replace(/''/g, "'");
    expect(() => parseSettings(JSON.parse(unescaped))).not.toThrow();
  });
});

describe("seedDev", () => {
  it("executes the seed SQL against the local D1 database", async () => {
    const commands: string[][] = [];
    await seedDev({
      args: [],
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
      },
      log: () => undefined
    });

    expect(commands).toHaveLength(1);
    expect(commands[0].slice(0, 5)).toEqual(["wrangler", "d1", "execute", "minutesbot", "--local"]);
    expect(commands[0][5]).toBe("--command");
    expect(commands[0][6]).toContain("INSERT OR REPLACE INTO settings");
  });

  it("prints the SQL without executing when --print is passed", async () => {
    const commands: string[] = [];
    const messages: string[] = [];
    await seedDev({
      args: ["--print"],
      runCommand: async (command) => {
        commands.push(command);
      },
      log: (message) => messages.push(message)
    });

    expect(commands).toEqual([]);
    expect(messages.join("\n")).toContain("INSERT OR REPLACE INTO settings");
  });
});
