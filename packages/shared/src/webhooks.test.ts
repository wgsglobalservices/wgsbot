import { describe, expect, it } from "vitest";
import { botWebhookUrl } from "./webhooks";

describe("botWebhookUrl", () => {
  it("uses the dedicated meeting bot webhook base URL when configured", () => {
    expect(
      botWebhookUrl({
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        BOT_WEBHOOK_BASE_URL: "https://minutesbot-webhook.wgsglobal.app"
      })
    ).toBe("https://minutesbot-webhook.wgsglobal.app/api/webhooks/bot");
  });

  it("falls back to API_BASE_URL for existing deployments", () => {
    expect(botWebhookUrl({ API_BASE_URL: "https://meeting.minutes.bot/" })).toBe("https://meeting.minutes.bot/api/webhooks/bot");
  });
});
