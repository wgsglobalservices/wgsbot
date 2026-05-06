import { describe, expect, it } from "vitest";
import { attendeeWebhookUrl } from "./webhooks";

describe("attendeeWebhookUrl", () => {
  it("uses the dedicated Attendee webhook base URL when configured", () => {
    expect(
      attendeeWebhookUrl({
        API_BASE_URL: "https://minutesbot.wgsglobal.app",
        ATTENDEE_WEBHOOK_BASE_URL: "https://minutesbot-webhook.wgsglobal.app"
      })
    ).toBe("https://minutesbot-webhook.wgsglobal.app/api/webhooks/attendee");
  });

  it("falls back to API_BASE_URL for existing deployments", () => {
    expect(attendeeWebhookUrl({ API_BASE_URL: "https://api.company.com/" })).toBe("https://api.company.com/api/webhooks/attendee");
  });
});
