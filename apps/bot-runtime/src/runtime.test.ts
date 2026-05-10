import { describe, expect, it, vi } from "vitest";
import { __runtimeTest } from "./runtime";

describe("Teams runtime browser flow", () => {
  it("joins when Teams omits the guest display name field but still shows Join now", async () => {
    const joinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const page = fakePage({
      roles: [
        { role: "button", name: "Join now", locator: joinButton }
      ],
      texts: [
        { text: "Someone will let you in soon", locator: lobbyMessage }
      ]
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("waiting_room");
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("checks Teams pre-join frames for the Join now button", async () => {
    const frameJoinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const frame = fakePage({
      roles: [{ role: "button", name: "Join now", locator: frameJoinButton }],
      texts: [{ text: "Waiting in the lobby", locator: lobbyMessage }]
    });
    const page = fakePage({ frames: [frame] });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("waiting_room");
    expect(frameJoinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("clicks Teams join controls exposed only through raw selector attributes", async () => {
    const joinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const page = fakePage({
      locators: {
        'button[data-tid*="join" i]': joinButton
      },
      texts: [{ text: "Someone will let you in soon", locator: lobbyMessage }]
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("waiting_room");
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("presses Enter from the pre-join name field when no explicit Join control is visible", async () => {
    const nameInput = visibleLocator();
    const lobbyMessage = visibleLocator();
    const page = fakePage({
      roles: [{ role: "textbox", name: "Type your name", locator: nameInput }],
      texts: [{ text: "Someone will let you in soon", locator: lobbyMessage }]
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("waiting_room");
    expect(nameInput.press).toHaveBeenCalledWith("Enter", { timeout: 1_000 });
  });

  it("does not press Enter when no pre-join form or Join control is visible", async () => {
    const page = fakePage();

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("Teams pre-join screen did not show a Join now button.");
  });

  it("includes a compact pre-join diagnostic when no Join control is discoverable", async () => {
    const page = fakePage({
      url: "https://teams.microsoft.com/l/meetup-join/secret?context=private",
      controls: [
        { tag: "button", text: "Continue without audio or video", tid: "prejoin-continue" },
        { tag: "input", placeholder: "Type your name", id: "displayName" }
      ]
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow(
      "url=teams.microsoft.com/l/meetup-join?..."
    );
    await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("controls=button/Continue without audio or video");
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

    await expect(__runtimeTest.fillGuestName(page, "minutesbot")).resolves.toBe(false);
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
type FakeControl = {
  tag: string;
  role?: string;
  text?: string;
  aria?: string;
  title?: string;
  placeholder?: string;
  tid?: string;
  id?: string;
};

function fakePage(input: {
  locators?: Record<string, FakeLocator>;
  roles?: Array<{ role: string; name: string; locator: FakeLocator }>;
  texts?: Array<{ text: string; locator: FakeLocator }>;
  frames?: unknown[];
  url?: string;
  controls?: FakeControl[];
} = {}) {
  const invisible = invisibleLocator();
  return {
    getByRole: vi.fn((role: string, options?: { name?: RegExp }) => {
      return input.roles?.find((entry) => entry.role === role && (!options?.name || options.name.test(entry.name)))?.locator ?? invisible;
    }),
    getByPlaceholder: vi.fn(() => invisible),
    getByText: vi.fn((pattern: RegExp) => {
      return input.texts?.find((entry) => pattern.test(entry.text))?.locator ?? invisible;
    }),
    locator: vi.fn((selector: string) => input.locators?.[selector] ?? invisible),
    frames: input.frames ? vi.fn(() => input.frames) : undefined,
    url: vi.fn(() => input.url ?? "https://teams.microsoft.com/l/meetup-join/test?context=secret"),
    evaluate: vi.fn(async () => input.controls ?? []),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined)
  };
}

function invisibleLocator() {
  const first = {
    isVisible: vi.fn(async () => false),
    fill: vi.fn(),
    click: vi.fn(),
    press: vi.fn(),
    isChecked: vi.fn(async () => false)
  };
  return {
    first: () => first,
    isVisible: first.isVisible,
    fill: first.fill,
    click: first.click,
    press: first.press,
    count: vi.fn(async () => 0),
    isChecked: first.isChecked
  };
}

function visibleLocator() {
  const first = {
    isVisible: vi.fn(async () => true),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    isChecked: vi.fn(async () => false)
  };
  return {
    first: () => first,
    isVisible: vi.fn(async () => true),
    fill: first.fill,
    click: first.click,
    press: first.press,
    count: vi.fn(async () => 1),
    isChecked: first.isChecked
  };
}
