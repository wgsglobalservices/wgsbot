import { describe, expect, it, vi } from "vitest";
import * as entrypoint from "./index";
import { app } from "./index";

class FakeD1 {
  prepare() {
    return {
      bind() {
        return this;
      },
      async first() {
        return null;
      },
      async run() {
        return { success: true };
      },
      async all() {
        return { results: [] };
      }
    };
  }
}

describe("api worker", () => {
  it("returns health", async () => {
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("requires auth configuration for protected admin routes", async () => {
    const response = await app.request("/api/settings");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AUTH_NOT_CONFIGURED",
        message: "Configure SESSION_SECRET before exposing admin routes."
      }
    });
  });

  it("exports the configured meeting workflow entrypoint", () => {
    expect(entrypoint).toHaveProperty("MeetingWorkflow");
  });

  it("queues manual transcript fetches as forced Attendee requests", async () => {
    const send = vi.fn(async () => undefined);
    const response = await app.request(
      "/api/meetings/mtg_1/fetch-transcript",
      { method: "POST", headers: { authorization: "Bearer test-secret" } },
      {
        DB: new FakeD1() as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ type: "fetch_transcript", meetingId: "mtg_1", forceAttendeeFetch: true });
  });

  it("handles inbound email on the deployed worker entrypoint", async () => {
    const raw = `From: Alice <alice@wgs.bot>
To: Alice <alice@wgs.bot>

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-api-email
SUMMARY:API Entrypoint Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`;
    const queueInvite = vi.fn(async () => undefined);
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);

    await entrypoint.default.email(
      {
        from: "alice@wgs.bot",
        to: "notetaker@wgs.bot",
        raw: new Response(raw).body!,
        setReject: vi.fn()
      },
      {
        DB: new FakeD1() as unknown as D1Database,
        ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
        INVITE_QUEUE: { send: queueInvite }
      },
      { waitUntil } as unknown as ExecutionContext
    );

    await waitUntil.mock.calls[0][0];
    expect(queueInvite).toHaveBeenCalledOnce();
  });
});
