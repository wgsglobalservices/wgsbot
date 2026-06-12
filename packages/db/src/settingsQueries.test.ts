import { describe, expect, it } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { getSettings, saveSettings } from "./settingsQueries";

class MemoryD1 {
  rows = new Map<string, string>();
  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM settings")) {
          const key = this.values[0] as string;
          const value = db.rows.get(key);
          return value ? ({ key, value, updated_at: new Date().toISOString() } as T) : null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT OR REPLACE INTO settings")) {
          db.rows.set(this.values[0] as string, this.values[1] as string);
        }
        return { success: true };
      }
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

describe("settings queries", () => {
  it("returns defaults when settings are absent and persists normalized settings", async () => {
    const db = new MemoryD1() as unknown as D1Database;
    await expect(getSettings(db)).resolves.toEqual(defaultSettings);

    const saved = await saveSettings(db, { ...defaultSettings, primaryDomain: "AcMe.COM", allowedDomains: ["AcMe.COM"] });
    expect(saved.primaryDomain).toBe("acme.com");
    await expect(getSettings(db)).resolves.toMatchObject({ primaryDomain: "acme.com" });
  });
});
