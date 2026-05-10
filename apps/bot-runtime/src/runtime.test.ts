import { describe, expect, it, vi } from "vitest";
import { __runtimeTest } from "./runtime";

describe("Teams runtime browser flow", () => {
  it("fills the guest display name from Teams pre-join input selectors when accessibility locators miss it", async () => {
    const rawNameInput = visibleLocator();
    const page = fakePage({
      locators: {
        'input[data-tid="prejoin-display-name-input"]': rawNameInput
      }
    });

    await __runtimeTest.fillGuestName(page, "minutesbot");

    expect(rawNameInput.fill).toHaveBeenCalledWith("minutesbot", { timeout: 20_000 });
  });

  it("checks Teams pre-join frames for the guest display name field", async () => {
    const frameNameInput = visibleLocator();
    const frame = fakePage({
      locators: {
        'input[data-tid="prejoin-display-name-input"]': frameNameInput
      }
    });
    const page = fakePage({ frames: [frame] });

    await __runtimeTest.fillGuestName(page, "minutesbot");

    expect(frameNameInput.fill).toHaveBeenCalledWith("minutesbot", { timeout: 20_000 });
  });
});

function fakePage(input: { locators?: Record<string, ReturnType<typeof visibleLocator>>; frames?: unknown[] } = {}) {
  const invisible = invisibleLocator();
  return {
    getByRole: vi.fn(() => invisible),
    getByPlaceholder: vi.fn(() => invisible),
    getByText: vi.fn(() => invisible),
    locator: vi.fn((selector: string) => input.locators?.[selector] ?? invisible),
    frames: input.frames ? vi.fn(() => input.frames) : undefined
  };
}

function invisibleLocator() {
  return {
    first: () => ({
      isVisible: vi.fn(async () => false),
      fill: vi.fn()
    }),
    isVisible: vi.fn(async () => false)
  };
}

function visibleLocator() {
  const first = {
    isVisible: vi.fn(async () => true),
    fill: vi.fn(async () => undefined)
  };
  return {
    first: () => first,
    isVisible: vi.fn(async () => true),
    fill: first.fill
  };
}
