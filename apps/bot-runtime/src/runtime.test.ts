import { describe, expect, it, vi } from "vitest";
import { __runtimeTest } from "./runtime";

describe("Teams runtime browser flow", () => {
  it("joins when Teams omits the guest display name field but still shows Join now", async () => {
    const joinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    let admitted = false;
    const page = fakePage({
      roles: [
        { role: "button", name: "Join now", locator: joinButton }
      ],
      texts: () => [
        ...(!admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("checks Teams pre-join frames for the Join now button", async () => {
    const frameJoinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    let admitted = false;
    const frame = fakePage({
      roles: [{ role: "button", name: "Join now", locator: frameJoinButton }],
      texts: () => [
        ...(!admitted ? [{ text: "Waiting in the lobby", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ]
    });
    const page = fakePage({ frames: [frame], onWaitForTimeout: async () => { admitted = true; } });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(frameJoinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("waits for a Teams v2 pre-join frame to render guest name and Join now controls", async () => {
    let rendered = false;
    let joined = false;
    let admitted = false;
    const frameNameInput = visibleLocator();
    const frameJoinButton = visibleLocator(() => {
      joined = true;
    });
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    const frame = fakePage({
      url: "https://teams.microsoft.com/v2/?meetingjoin=true",
      locators: () => (rendered ? { 'input[data-tid="prejoin-display-name-input"]': frameNameInput } : {}),
      roles: () => (rendered ? [{ role: "button", name: "Join now", locator: frameJoinButton }] : []),
      texts: () => [
        ...(joined && !admitted ? [{ text: "Waiting in the lobby", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ]
    });
    const page = fakePage({
      url: "https://teams.microsoft.com/v2/?meetingjoin=true",
      frames: [frame],
      onWaitForTimeout: async () => {
        if (!rendered) rendered = true;
        else admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(frameNameInput.fill).toHaveBeenCalledWith("minutesbot", { timeout: 1_000 });
    expect(frameJoinButton.click).toHaveBeenCalled();
  });

  it("continues through browser entry and device prompts that appear after Teams v2 renders", async () => {
    let webEntryRendered = false;
    let prejoinRendered = false;
    let joined = false;
    let admitted = false;
    const webEntry = visibleLocator();
    const audioPrompt = visibleLocator();
    const joinButton = visibleLocator(() => {
      joined = true;
    });
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    const page = fakePage({
      url: "https://teams.microsoft.com/v2/?meetingjoin=true",
      roles: () => [
        ...(webEntryRendered ? [{ role: "button", name: "Continue on this browser", locator: webEntry }] : []),
        ...(prejoinRendered ? [{ role: "button", name: "Continue without audio or video", locator: audioPrompt }] : []),
        ...(prejoinRendered ? [{ role: "button", name: "Join now", locator: joinButton }] : [])
      ],
      texts: () => [
        ...(joined && !admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        if (!webEntryRendered) webEntryRendered = true;
        else if (!prejoinRendered) prejoinRendered = true;
        else admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(webEntry.click).toHaveBeenCalled();
    expect(audioPrompt.click).toHaveBeenCalled();
    expect(joinButton.click).toHaveBeenCalled();
  });

  it("keeps polling when a Teams browser-entry text locator is visible but not actionable", async () => {
    let prejoinRendered = false;
    let joined = false;
    let admitted = false;
    const webEntryText = visibleLocator();
    webEntryText.click.mockRejectedValue(new Error("locator.click: Timeout 20000ms exceeded"));
    const joinButton = visibleLocator(() => {
      joined = true;
    });
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    const page = fakePage({
      url: "https://teams.microsoft.com/v2/?meetingjoin=true",
      roles: () => (prejoinRendered ? [{ role: "button", name: "Join now", locator: joinButton }] : []),
      texts: () => [
        ...(!prejoinRendered ? [{ text: "Continue on this browser", locator: webEntryText }] : []),
        ...(joined && !admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        if (!prejoinRendered) prejoinRendered = true;
        else admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(webEntryText.click).toHaveBeenCalledWith({ timeout: 1_000 });
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("waits for a meeting that has not started and joins when Teams enables the join control", async () => {
    let meetingStarted = false;
    let joined = false;
    let admitted = false;
    const notStartedMessage = visibleLocator();
    const joinButton = visibleLocator(() => {
      joined = true;
    });
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    const page = fakePage({
      roles: () => (meetingStarted ? [{ role: "button", name: "Join now", locator: joinButton }] : []),
      texts: () => [
        ...(!meetingStarted ? [{ text: "When the meeting starts, we'll let people know you're waiting", locator: notStartedMessage }] : []),
        ...(joined && !admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        if (!meetingStarted) meetingStarted = true;
        else admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(page.waitForTimeout).toHaveBeenCalled();
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("stays parked after clicking Join when Teams says the meeting has not started yet", async () => {
    let clickedJoin = false;
    let meetingStarted = false;
    const joinButton = visibleLocator(() => {
      clickedJoin = true;
    });
    const notStartedMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    const page = fakePage({
      roles: () => (!clickedJoin ? [{ role: "button", name: "Join now", locator: joinButton }] : []),
      texts: () => [
        ...(clickedJoin && !meetingStarted ? [{ text: "When the meeting starts, we'll let people know you're waiting", locator: notStartedMessage }] : []),
        ...(clickedJoin && meetingStarted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        meetingStarted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(page.waitForTimeout).toHaveBeenCalled();
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("emits waiting_room as progress and waits for a confirmed joined state before returning", async () => {
    const states: string[] = [];
    let joined = false;
    let admitted = false;
    const joinButton = visibleLocator(() => {
      joined = true;
    });
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    const page = fakePage({
      roles: [{ role: "button", name: "Join now", locator: joinButton }],
      texts: () => [
        ...(joined && !admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(
      __runtimeTest.joinAsGuest(page, {
        ...guestInput(),
        onState: async (state) => {
          states.push(state);
        }
      })
    ).resolves.toBe("joined");

    expect(states).toEqual(["prejoin", "waiting_room"]);
    expect(page.waitForTimeout).toHaveBeenCalled();
  });

  it("fails instead of recording when the lobby does not admit the bot before the join timeout", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 0;
    nowSpy.mockImplementation(() => now);
    const joinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const page = fakePage({
      roles: [{ role: "button", name: "Join now", locator: joinButton }],
      texts: [{ text: "Someone will let you in soon", locator: lobbyMessage }],
      onWaitForTimeout: async () => {
        now += 1_000;
      }
    });

    try {
      await expect(__runtimeTest.joinAsGuest(page, { ...guestInput(), joinTimeoutSeconds: 1 })).rejects.toThrow(
        "Meeting bot did not join before the 1 second timeout expired"
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("times out startup commands instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    try {
      const pending = __runtimeTest.recordBrowserAudio(
        { BOT_RECORDING_SECONDS: "3", BOT_AUDIO_SINK_NAME: "teams_capture", BOT_PROCESS_TIMEOUT_MS: "25" },
        {
          mkdtemp: async () => "/tmp/minutesbot-recording",
          readFile: async () => new Uint8Array([1]),
          rm: vi.fn(async () => undefined),
          runCommand: async () => new Promise(() => undefined)
        }
      );
      const assertion = expect(pending).rejects.toThrow("pulseaudio timed out after 25ms");

      await vi.advanceTimersByTimeAsync(25);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a guest-join blocker instead of a missing Join now button", async () => {
    const page = fakePage({
      url: "https://teams.microsoft.com/v2/?tenant=private",
      texts: [{ text: "Sign in to join this meeting", locator: visibleLocator() }],
      controls: [{ tag: "button", text: "Sign in", tid: "signin-button" }],
      bodyText: "Sign in to join this meeting"
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("Teams guest join is blocked or requires sign-in.");
  });

  it("clicks Teams join controls exposed only through raw selector attributes", async () => {
    const joinButton = visibleLocator();
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    let admitted = false;
    const page = fakePage({
      locators: {
        'button[data-tid*="join" i]': joinButton
      },
      texts: () => [
        ...(!admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("presses Enter from the pre-join name field when no explicit Join control is visible", async () => {
    const nameInput = visibleLocator();
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    let admitted = false;
    const page = fakePage({
      roles: [{ role: "textbox", name: "Type your name", locator: nameInput }],
      texts: () => [
        ...(!admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(nameInput.press).toHaveBeenCalledWith("Enter", { timeout: 1_000 });
  });

  it("does not press Enter when no pre-join form or Join control is visible", async () => {
    const page = fakePage();

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("Teams pre-join screen did not show a Join now button.");
  });

  it("includes a compact pre-join diagnostic when no Join control is discoverable", async () => {
    const previousVersion = process.env.BOT_RUNTIME_VERSION;
    process.env.BOT_RUNTIME_VERSION = "041f23c";
    const page = fakePage({
      url: "https://teams.microsoft.com/l/meetup-join/secret?context=private",
      controls: [
        { tag: "button", text: "Continue without audio or video", tid: "prejoin-continue" },
        { tag: "input", placeholder: "Type your name", id: "displayName" }
      ]
    });

    try {
      await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow(
        "url=teams.microsoft.com/l/meetup-join?..."
      );
      await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("controls=button/Continue without audio or video");
      await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("ready=");
      await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("body=");
      await expect(__runtimeTest.joinAsGuest(page, guestInput())).rejects.toThrow("diagnosticVersion=041f23c");
    } finally {
      if (previousVersion === undefined) delete process.env.BOT_RUNTIME_VERSION;
      else process.env.BOT_RUNTIME_VERSION = previousVersion;
    }
  });

  it("emits prejoin before Teams admission and does not emit joined before confirmation", async () => {
    const states: string[] = [];
    let joined = false;
    let admitted = false;
    const joinButton = visibleLocator(() => {
      joined = true;
    });
    const lobbyMessage = visibleLocator();
    const joinedMessage = visibleLocator();
    const page = fakePage({
      roles: [{ role: "button", name: "Join now", locator: joinButton }],
      texts: () => [
        ...(joined && !admitted ? [{ text: "Someone will let you in soon", locator: lobbyMessage }] : []),
        ...(admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : [])
      ],
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(
      __runtimeTest.joinAsGuest(page, {
        ...guestInput(),
        onState: async (state) => {
          states.push(state);
        }
      })
    ).resolves.toBe("joined");

    expect(states).toEqual(["prejoin", "waiting_room"]);
  });

  it("starts PulseAudio capture from the Teams monitor and records MP3 bytes", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const files = new Map<string, Uint8Array>([["/tmp/minutesbot-recording/recording.mp3", new Uint8Array([7, 8, 9])]]);
    const result = await __runtimeTest.recordBrowserAudio(
      { BOT_RECORDING_SECONDS: "3", BOT_AUDIO_SINK_NAME: "teams_capture" },
      {
        mkdtemp: async () => "/tmp/minutesbot-recording",
        readFile: async (path) => files.get(path) ?? new Uint8Array(),
        rm: vi.fn(async () => undefined),
        runCommand: async (command, args) => {
          commands.push({ command, args });
        }
      }
    );

    expect(commands).toEqual([
      { command: "pulseaudio", args: ["--start"] },
      { command: "pactl", args: ["load-module", "module-null-sink", "sink_name=teams_capture", "sink_properties=device.description=minutesbot_teams_capture"] },
      {
        command: "ffmpeg",
        args: [
          "-y",
          "-f",
          "pulse",
          "-i",
          "teams_capture.monitor",
          "-t",
          "3",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-acodec",
          "libmp3lame",
          "/tmp/minutesbot-recording/recording.mp3"
        ]
      },
      { command: "pactl", args: ["unload-module", "0"] }
    ]);
    expect(result).toEqual(new Uint8Array([7, 8, 9]));
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
type FakeLocatorMap = Partial<Record<string, FakeLocator>>;
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

type FakePageInput = {
  locators?: FakeLocatorMap | (() => FakeLocatorMap);
  roles?: Array<{ role: string; name: string; locator: FakeLocator }> | (() => Array<{ role: string; name: string; locator: FakeLocator }>);
  texts?: Array<{ text: string; locator: FakeLocator }> | (() => Array<{ text: string; locator: FakeLocator }>);
  frames?: unknown[] | (() => unknown[]);
  url?: string;
  controls?: FakeControl[] | (() => FakeControl[]);
  bodyText?: string | (() => string);
  readyState?: string | (() => string);
  onWaitForTimeout?: () => Promise<void> | void;
};

function fakePage(input: FakePageInput = {}) {
  const invisible = invisibleLocator();
  const current = <T>(value: T | (() => T) | undefined, fallback: T): T => (typeof value === "function" ? (value as () => T)() : value ?? fallback);
  return {
    getByRole: vi.fn((role: string, options?: { name?: RegExp }) => {
      return current(input.roles, []).find((entry) => entry.role === role && (!options?.name || options.name.test(entry.name)))?.locator ?? invisible;
    }),
    getByPlaceholder: vi.fn(() => invisible),
    getByText: vi.fn((pattern: RegExp) => {
      return current(input.texts, []).find((entry) => pattern.test(entry.text))?.locator ?? invisible;
    }),
    locator: vi.fn((selector: string) => current(input.locators, {})[selector] ?? invisible),
    frames: input.frames ? vi.fn(() => current(input.frames, [])) : undefined,
    url: vi.fn(() => input.url ?? "https://teams.microsoft.com/l/meetup-join/test?context=secret"),
    evaluate: vi.fn(async (fn?: () => unknown) => {
      if (String(fn).includes("document.readyState")) return current(input.readyState, "complete");
      if (String(fn).includes("document.body")) return current(input.bodyText, "");
      return current(input.controls, []);
    }),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => {
      await input.onWaitForTimeout?.();
    })
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

function visibleLocator(onClick?: () => void) {
  const first = {
    isVisible: vi.fn(async () => true),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => {
      onClick?.();
    }),
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
