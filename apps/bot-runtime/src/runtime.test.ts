import { describe, expect, it, vi } from "vitest";
import { __runtimeTest } from "./runtime";

describe("Teams runtime browser flow", () => {
  it("uses hardened Chromium launch args while preserving existing media flags", () => {
    expect(__runtimeTest.chromiumLaunchArgs).toEqual(
      expect.arrayContaining([
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--use-fake-device-for-media-stream",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-application-cache",
        "--window-size=1930,1090"
      ])
    );
    expect(__runtimeTest.chromiumLaunchArgs).not.toContain("--no-sandbox");
    expect(__runtimeTest.chromiumLaunchArgs).not.toContain("--disable-setuid-sandbox");
  });

  it("uses exact Teams guest selectors, grants media permissions, disables media, and confirms in-meeting controls", async () => {
    const mediaPermissions = vi.fn(async () => undefined);
    const nameInput = visibleLocator();
    const microphoneToggle = visibleLocator();
    microphoneToggle.isChecked.mockResolvedValue(true);
    const cameraToggle = visibleLocator();
    cameraToggle.isChecked.mockResolvedValue(true);
    const joinButton = visibleLocator(() => {
      joined = true;
    });
    const showMoreButton = visibleLocator();
    let joined = false;
    const page = fakePage({
      context: { grantPermissions: mediaPermissions },
      locators: {
        'input[data-tid="prejoin-display-name-input"]': nameInput,
        '[data-tid="toggle-mute"]': microphoneToggle,
        '[data-tid="toggle-video"]': cameraToggle,
        '[data-tid="prejoin-join-button"]': joinButton,
        "#callingButtons-showMoreBtn": showMoreButton
      },
      locatorsFor: (selector) => (selector === "#callingButtons-showMoreBtn" && joined ? showMoreButton : undefined)
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");

    expect(mediaPermissions).toHaveBeenCalledWith(["geolocation", "microphone", "camera"], { origin: "https://teams.microsoft.com" });
    expect(mediaPermissions).toHaveBeenCalledWith(["geolocation", "microphone", "camera"], { origin: "https://teams.live.com" });
    expect(mediaPermissions).toHaveBeenCalledWith(["geolocation", "microphone", "camera"], { origin: "https://teams.cloud.microsoft" });
    expect(nameInput.fill).toHaveBeenCalledWith("minutesbot", { timeout: 1_000 });
    expect(microphoneToggle.click).toHaveBeenCalledWith({ timeout: 1_000 });
    expect(cameraToggle.click).toHaveBeenCalledWith({ timeout: 1_000 });
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(showMoreButton.isVisible).toHaveBeenCalled();
  });

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

  it("emits waiting_room immediately after a successful Join click even before Teams renders lobby text", async () => {
    const states: string[] = [];
    const logs: string[] = [];
    let joined = false;
    let admitted = false;
    const joinButton = visibleLocator(() => {
      joined = true;
    });
    const joinedMessage = visibleLocator();
    const page = fakePage({
      roles: () => (!joined ? [{ role: "button", name: "Ask to join", locator: joinButton }] : []),
      texts: () => (admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : []),
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(
      __runtimeTest.joinAsGuest(page, {
        ...guestInput(),
        onState: async (state) => {
          states.push(state);
        },
        onLog: async (log) => {
          logs.push(log.message);
        }
      })
    ).resolves.toBe("joined");

    expect(states).toEqual(["prejoin", "waiting_room"]);
    expect(logs).toContain("Clicked Teams join control; waiting for admission");
  });

  it("detects Teams lobby text variants", async () => {
    const variants = [
      "Someone will let you in soon",
      "You're in the lobby",
      "Waiting in the lobby",
      "We've let people in the meeting know you're waiting",
      "People in the meeting know you're waiting",
      "You'll join when someone lets you in",
      "Hang tight",
      "Wait for someone to admit you",
      "waiting to be admitted"
    ];

    for (const text of variants) {
      const states: string[] = [];
      const joinedMessage = visibleLocator();
      let admitted = false;
      const page = fakePage({
        texts: () => [
          ...(!admitted ? [{ text, locator: visibleLocator() }] : []),
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
    }
  });

  it("clicks a Teams Join button exposed only through button#prejoin-join-button", async () => {
    const joinButton = visibleLocator();
    const joinedMessage = visibleLocator();
    let admitted = false;
    const page = fakePage({
      locators: {
        "button#prejoin-join-button": joinButton
      },
      texts: () => (admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : []),
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("clicks a Teams web-entry button exposed only through raw selector attributes", async () => {
    let prejoinRendered = false;
    let admitted = false;
    const webEntry = visibleLocator(() => {
      prejoinRendered = true;
    });
    const joinButton = visibleLocator();
    const joinedMessage = visibleLocator();
    const page = fakePage({
      locators: () => ({
        ...(!prejoinRendered ? { 'button[data-tid*="join-on-web" i]': webEntry } : {}),
        ...(prejoinRendered ? { 'button[data-tid="prejoin-join-button"]': joinButton } : {})
      }),
      texts: () => (admitted ? [{ text: "You're the only one here", locator: joinedMessage }] : []),
      onWaitForTimeout: async () => {
        admitted = true;
      }
    });

    await expect(__runtimeTest.joinAsGuest(page, guestInput())).resolves.toBe("joined");
    expect(webEntry.click).toHaveBeenCalledWith({ timeout: 1_000 });
    expect(joinButton.click).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("emits redacted prejoin diagnostics during long prejoin polling", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 0;
    nowSpy.mockImplementation(() => now);
    const logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const page = fakePage({
      url: "https://teams.microsoft.com/l/meetup-join/secret?context=private&email=person@example.com",
      controls: [{ tag: "button", text: "Continue on this browser", tid: "join-on-web" }],
      onWaitForTimeout: async () => {
        now += 1_000;
      }
    });

    try {
      await expect(
        __runtimeTest.joinAsGuest(page, {
          ...guestInput(),
          joinTimeoutSeconds: 16,
          onLog: async (log) => {
            logs.push(log);
          }
        })
      ).rejects.toThrow("Meeting bot did not join before the 16 seconds timeout expired");
    } finally {
      nowSpy.mockRestore();
    }

    const diagnosticLog = logs.find((log) => log.message === "Teams prejoin diagnostic");
    expect(diagnosticLog?.details).toMatchObject({
      attempt: expect.any(Number),
      url: "teams.microsoft.com/l/meetup-join?...",
      hasNameField: false,
      hasJoinButton: false,
      hasWebEntryButton: true,
      hasLobbyText: false,
      hasJoinedSignal: false
    });
    expect(JSON.stringify(diagnosticLog?.details)).not.toContain("person@example.com");
    expect(JSON.stringify(diagnosticLog?.details)).not.toContain("context=private");
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

  it("classifies Teams captcha, denied, and connection blocker messages", async () => {
    await expect(
      __runtimeTest.joinAsGuest(fakePage({ texts: [{ text: "Verify you're a real person", locator: visibleLocator() }] }), guestInput())
    ).rejects.toThrow("Teams blocked guest join with a captcha.");

    await expect(
      __runtimeTest.joinAsGuest(fakePage({ texts: [{ text: "Your request to join was declined", locator: visibleLocator() }] }), guestInput())
    ).rejects.toThrow("Someone in the meeting denied the bot request to join.");

    await expect(
      __runtimeTest.joinAsGuest(fakePage({ texts: [{ text: "Sorry, we couldn't connect you", locator: visibleLocator() }] }), guestInput())
    ).rejects.toThrow("Teams could not connect the bot.");
  });

  it("retries retryable pre-join failures with a fresh page factory but does not retry hard blockers", async () => {
    const pages = [
      fakePage(),
      fakePage({
        locators: { '[data-tid="prejoin-join-button"]': visibleLocator() },
        texts: [{ text: "You're the only one here", locator: visibleLocator() }]
      })
    ];
    let index = 0;

    await expect(
      __runtimeTest.joinWithRetries(
        () => pages[index++] ?? pages.at(-1)!,
        guestInput(),
        __runtimeTest.createJoinDeadline(15 * 60)
      )
    ).resolves.toBe("joined");
    expect(index).toBe(2);

    const hardBlockerFactory = vi.fn(() => fakePage({ texts: [{ text: "Sign in to join this meeting", locator: visibleLocator() }] }));
    await expect(
      __runtimeTest.joinWithRetries(hardBlockerFactory, guestInput(), __runtimeTest.createJoinDeadline(15 * 60))
    ).rejects.toThrow("Teams guest join is blocked or requires sign-in.");
    expect(hardBlockerFactory).toHaveBeenCalledTimes(1);
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

  it("emits recording after confirmed join and before ffmpeg capture starts", async () => {
    const states: string[] = [];
    const events: string[] = [];
    const result = await __runtimeTest.recordBrowserJoinedAudio(
      { BOT_RECORDING_SECONDS: "3", BOT_AUDIO_SINK_NAME: "teams_capture" },
      {
        mkdtemp: async () => "/tmp/minutesbot-recording",
        readFile: async () => {
          events.push("readFile");
          return new Uint8Array([1]);
        },
        rm: vi.fn(async () => undefined),
        runCommand: async (command) => {
          events.push(command);
        }
      },
      async (state) => {
        states.push(state);
        events.push(`state:${state}`);
      }
    );

    expect(result).toEqual(new Uint8Array([1]));
    expect(states).toEqual(["recording"]);
    expect(events.indexOf("state:recording")).toBeGreaterThan(events.indexOf("pactl"));
    expect(events.indexOf("state:recording")).toBeLessThan(events.indexOf("ffmpeg"));
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
          if (command === "pactl" && args[0] === "load-module") return "42";
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
      { command: "pactl", args: ["unload-module", "42"] }
    ]);
    expect(result).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("passes an abort signal into ffmpeg capture and returns partial MP3 bytes", async () => {
    const controller = new AbortController();
    let ffmpegSignal: AbortSignal | undefined;
    const pending = __runtimeTest.captureBrowserAudio(
      { BOT_RECORDING_SECONDS: "300" },
      {
        mkdtemp: async () => "/tmp/minutesbot-recording",
        readFile: async () => new Uint8Array([4, 5, 6]),
        rm: vi.fn(async () => undefined),
        runCommand: async (_command, _args, options) => {
          ffmpegSignal = options?.signal;
          await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("ffmpeg was stopped");
        }
      },
      "teams_capture",
      { signal: controller.signal }
    );

    await vi.waitFor(() => expect(ffmpegSignal).toBeDefined());
    controller.abort("force end recording");

    await expect(pending).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(ffmpegSignal?.aborted).toBe(true);
  });

  it("throws when aborted ffmpeg capture produces no MP3 bytes", async () => {
    const controller = new AbortController();
    const pending = __runtimeTest.captureBrowserAudio(
      { BOT_RECORDING_SECONDS: "300" },
      {
        mkdtemp: async () => "/tmp/minutesbot-recording",
        readFile: async () => new Uint8Array(),
        rm: vi.fn(async () => undefined),
        runCommand: async (_command, _args, options) => {
          controller.abort("force end recording");
          if (!options?.signal?.aborted) {
            await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
          }
          throw new Error("ffmpeg was stopped");
        }
      },
      "teams_capture",
      { signal: controller.signal }
    );

    await expect(pending).rejects.toThrow("ffmpeg stopped before producing recording bytes");
  });

  it("aborts recording when Teams shows meeting-ended text", async () => {
    const page = fakePage({ texts: [{ text: "This meeting has ended", locator: visibleLocator() }] });
    const pending = __runtimeTest.captureBrowserAudio(
      { BOT_RECORDING_SECONDS: "300" },
      {
        mkdtemp: async () => "/tmp/minutesbot-recording",
        readFile: async () => new Uint8Array([8, 8, 8]),
        rm: vi.fn(async () => undefined),
        runCommand: async (_command, _args, options) => {
          await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("ffmpeg was stopped");
        }
      },
      "teams_capture",
      { stopWhen: __runtimeTest.waitForTeamsMeetingEnd(page, new AbortController().signal) }
    );

    await expect(pending).resolves.toEqual(new Uint8Array([8, 8, 8]));
  });

  it("detects removed-from-meeting text as a Teams meeting end signal", async () => {
    const page = fakePage({ texts: [{ text: "You've been removed from this meeting", locator: visibleLocator() }] });

    await expect(__runtimeTest.waitForTeamsMeetingEnd(page, new AbortController().signal)).resolves.toBe("removed");
  });

  it("kills an ffmpeg child process that ignores SIGTERM after abort", async () => {
    const controller = new AbortController();
    const pending = __runtimeTest.runProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { signal: controller.signal, killGraceMs: 10 }
    );

    setTimeout(() => controller.abort("force end recording"), 10);

    await expect(pending).resolves.toBe("");
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
  locatorsFor?: (selector: string) => FakeLocator | undefined;
  roles?: Array<{ role: string; name: string; locator: FakeLocator }> | (() => Array<{ role: string; name: string; locator: FakeLocator }>);
  texts?: Array<{ text: string; locator: FakeLocator }> | (() => Array<{ text: string; locator: FakeLocator }>);
  frames?: unknown[] | (() => unknown[]);
  url?: string;
  context?: { grantPermissions?: ReturnType<typeof vi.fn> };
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
    locator: vi.fn((selector: string) => input.locatorsFor?.(selector) ?? current(input.locators, {})[selector] ?? invisible),
    context: vi.fn(() => input.context ?? {}),
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
