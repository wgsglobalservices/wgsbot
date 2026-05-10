import { describe, expect, it } from "vitest";
import { botWebhookUrl } from "./webhooks";

describe("botWebhookUrl", () => {
  it("uses the dedicated meeting bot webhook base URL when configured", () => {
    expect(
      botWebhookUrl({
        API_BASE_URL: "https://minutesbot-api.example.com",
        BOT_WEBHOOK_BASE_URL: "https://minutesbot-webhook.example.com"
      })
    ).toBe("https://minutesbot-webhook.example.com/api/webhooks/bot");
  });

  it("falls back to API_BASE_URL for existing deployments", () => {
    expect(botWebhookUrl({ API_BASE_URL: "https://meeting.minutes.bot/" })).toBe("https://meeting.minutes.bot/api/webhooks/bot");
  });
});
