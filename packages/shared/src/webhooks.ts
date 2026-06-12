export function botWebhookUrl(env: { API_BASE_URL: string; BOT_WEBHOOK_BASE_URL?: string; ATTENDEE_WEBHOOK_BASE_URL?: string }): string {
  return `${(env.BOT_WEBHOOK_BASE_URL || env.ATTENDEE_WEBHOOK_BASE_URL || env.API_BASE_URL).replace(/\/+$/, "")}/api/webhooks/bot`;
}

export const attendeeWebhookUrl = botWebhookUrl;
