import { describe, expect, it, vi } from "vitest";
import { __runtimeTest } from "./runtime";

describe("Teams runtime browser flow", () => {
  it("joins when Teams omits the guest display name field but still shows Join now", async () => {
    const joinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const page = fakePage({
      roles: [
        { role: "button", name: /^join now$/i, locator: joinButton }
      ],
      texts: [
        { pattern: /someone.*let you in|waiting.*lobby|you(?:'|’)re in the lobby|when the meeting starts/i, locator: lobbyMessage }
      ]
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("waiting_room");
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

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

  it("does not fail before the Join button when Teams omits the guest display name field", async () => {
    const page = fakePage();

    await expect(__runtimeTest.fillGuestName(page, "minutesbot")).resolves.toBeUndefined();
  });
});

function guestInput() {
  return {
    meetingUrl: "https://teams.microsoft.com/l/meetup-join/test",
    botName: "minutesbot",
    allowGuestJoin: true
  };
}

type FakeLocator = ReturnType<typeof visibleLocator>;

function fakePage(input: {
  locators?: Record<string, FakeLocator>;
  roles?: Array<{ role: string; name: RegExp; locator: FakeLocator }>;
  texts?: Array<{ pattern: RegExp; locator: FakeLocator }>;
  frames?: unknown[];
} = {}) {
  const invisible = invisibleLocator();
  return {
    getByRole: vi.fn((role: string, options?: { name?: RegExp }) => {
      return input.roles?.find((entry) => entry.role === role && options?.name?.source === entry.name.source)?.locator ?? invisible;
    }),
    getByPlaceholder: vi.fn(() => invisible),
    getByText: vi.fn((pattern: RegExp) => {
      return input.texts?.find((entry) => entry.pattern.source === pattern.source)?.locator ?? invisible;
    }),
    locator: vi.fn((selector: string) => input.locators?.[selector] ?? invisible),
    frames: input.frames ? vi.fn(() => input.frames) : undefined,
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined)
  };
}

function invisibleLocator() {
  const first = {
    isVisible: vi.fn(async () => false),
    fill: vi.fn(),
    click: vi.fn(),
    isChecked: vi.fn(async () => false)
  };
  return {
    first: () => first,
    isVisible: first.isVisible,
    fill: first.fill,
    click: first.click,
    isChecked: first.isChecked
  };
}

function visibleLocator() {
  const first = {
    isVisible: vi.fn(async () => true),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    isChecked: vi.fn(async () => false)
  };
  return {
    first: () => first,
    isVisible: vi.fn(async () => true),
    fill: first.fill,
    click: first.click,
    isChecked: first.isChecked
  };
}
