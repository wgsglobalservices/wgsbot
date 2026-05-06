import { describe, expect, it } from "vitest";
import { parseHash } from "./App";

describe("app routing", () => {
  it("treats the legacy settings hash as the setup screen", () => {
    expect(parseHash("#/settings")).toEqual({ name: "setup" });
  });

  it("routes recap hashes to the recap screen", () => {
    expect(parseHash("#/recap")).toEqual({ name: "recap" });
  });
});
